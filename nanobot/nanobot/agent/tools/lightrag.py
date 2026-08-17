"""LightRAG vector-graph retrieval tool (multi-server aggregation)."""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Callable
from typing import Any, Literal
from urllib.parse import quote

import httpx
from loguru import logger
from pydantic import Field

from nanobot.agent.tools.base import Tool, ToolResult, tool_parameters
from nanobot.agent.tools.context import RequestContext, current_request_context
from nanobot.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from nanobot.config_base import Base
from nanobot.runtime_context import RuntimeContextBlock, wrap_runtime_context_lines
from nanobot.security.network import (
    PinnedDNSAsyncTransport,
    httpx_env_proxy_mounts,
    validate_url_target,
)
from nanobot.webui.workspaces import normalize_lightrag_workspaces

_QUERY_MODES = ("local", "global", "hybrid", "naive", "mix", "bypass")
# Legacy UI sentinel from the single-server workspace contract. It is not a
# valid multi-server routing key and is filtered out when resolving targets.
_DEFAULT_SENTINEL = "__default__"
_SKIP_MESSAGE = "No knowledge base selected; recall skipped."
_DISABLED_MESSAGE = "LightRAG knowledge base integration is disabled; recall skipped."


def _server_error(name: str, message: str) -> ToolResult:
    """Build a per-server error section for fan-out results."""
    return ToolResult.error(f"## Knowledge Base: {name}\n(error: {message})")


_MD_SPECIAL_RE = re.compile(r"[\\`*_{}\]#!|>+]")


def _reference_display_name(path: str) -> str:
    """Return a compact citation label while preserving the real file path."""
    normalized = path.replace("\\", "/")
    basename = normalized.rsplit("/", 1)[-1] or normalized
    if basename.lower().endswith(".pdf"):
        return f"📄{basename[:-4]}"
    return basename


def _md_safe_text(value: str) -> str:
    """Escape Markdown-significant characters in untrusted text.

    Applied to values that are interpolated into the Markdown context the
    agent and WebUI render (reference link labels, image alt text and VLM
    descriptions) so a malicious server response cannot inject links or
    images.  Newlines are collapsed to spaces and the classic Markdown
    specials are backslash-escaped.  Dots and dashes are deliberately left
    untouched (they dominate filenames such as ``demo.pdf``) and CJK text
    passes through unchanged.

    ``[`` and parentheses are deliberately left unescaped.  The WebUI
    markdown stack makes backslash-escaping them both unreliable and
    unnecessary: the custom ``remark-tex-math`` extension reads a
    backslash followed by ``(`` as an inline LaTeX delimiter (so escaping a
    literal ``(`` would swallow the rest of a citation label such as
    ``Original Paper (1706.03762v7)`` during rendering), and
    ``remark-gfm`` mis-tokenizes a backslash-escaped ``[`` as a real link
    opener.  Since ``]`` is always escaped, an injected ``[...](url)`` or
    ``![...](url)`` can never close its label, so no link
    or image can be formed even with ``[``/``(``/``)`` left literal.
    """
    value = re.sub(r"[\r\n]+", " ", value)
    return _MD_SPECIAL_RE.sub(lambda m: "\\" + m.group(0), value)


def _gateway_file_url(server_name: str, rel_path: str) -> str:
    """Build a gateway-proxied LightRAG file URL for a server + rel path."""
    clean_rel_path = quote(rel_path.replace("\\", "/").lstrip("/"))
    return f"/api/lightrag/file/{quote(server_name, safe='')}/{clean_rel_path}"


def _config_loader_factory() -> Callable[[], LightRagToolConfig]:
    """Return a config loader that re-reads the on-disk config only when it changes."""
    from nanobot.config.loader import get_config_path, load_config, resolve_config_env_vars

    cached_mtime: int | None = None
    cached_config: LightRagToolConfig | None = None

    def load() -> LightRagToolConfig:
        nonlocal cached_mtime, cached_config
        try:
            mtime = get_config_path().stat().st_mtime_ns
        except OSError:
            mtime = None
        if cached_config is not None and mtime == cached_mtime:
            return cached_config
        cached_config = resolve_config_env_vars(load_config()).tools.lightrag
        cached_mtime = mtime
        return cached_config

    return load


class LightRagServerConfig(Base):
    """Configuration for a single LightRAG knowledge base server."""
    name: str  # UI display name and routing primary key
    api_base: str = "http://127.0.0.1:9621"
    api_key: str | None = None
    default_query_mode: Literal["local", "global", "hybrid", "naive", "mix", "bypass"] = "mix"
    default_top_k: int | None = Field(default=None, ge=1, le=100)
    timeout: float = Field(default=60.0, gt=0)
    proxy: str | None = None
    include_references: bool = True
    include_chunk_content: bool = False


class LightRagToolConfig(Base):
    """LightRAG retrieval tool configuration (multi-server)."""
    enabled: bool = False
    servers: list[LightRagServerConfig] = Field(default_factory=list)
    default_workspace: str | None = None  # CLI-only fallback


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema(
            "Retrieval query: a natural-language question or keywords.",
            min_length=3,
        ),
        mode=StringSchema(
            "Retrieval mode. Omit to use configured default.",
            enum=_QUERY_MODES,
        ),
        top_k=IntegerSchema(
            description="Top-k chunks to retrieve (1-100). Omit to use server default.",
            minimum=1,
            maximum=100,
        ),
        only_need_context=BooleanSchema(
            description="Return only retrieved context without LLM synthesis (pure recall).",
        ),
        include_references=BooleanSchema(
            description="Include source references (file paths) in the result.",
        ),
        required=["query"],
    )
)
class LightRagQueryTool(Tool):
    """Query LightRAG servers for vector-graph hybrid retrieval."""

    config_key = "lightrag"
    _scopes = {"core", "subagent"}

    name = "lightrag_query"
    description = (
        "Retrieve knowledge from LightRAG vector stores. "
        "Returns synthesized answers and source references. "
        "Recall scope is determined by the user's UI selection."
    )

    @classmethod
    def config_cls(cls):
        return LightRagToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.lightrag.enabled

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        config_loader = None
        if getattr(ctx, "provider_snapshot_loader", None) is not None:
            config_loader = _config_loader_factory()
        return cls(
            config=ctx.config.lightrag,
            config_loader=config_loader,
        )

    def __init__(
        self,
        config: LightRagToolConfig | None = None,
        config_loader: Callable[[], LightRagToolConfig] | None = None,
    ) -> None:
        self.config = config if config is not None else LightRagToolConfig()
        self._config_loader = config_loader

    @property
    def read_only(self) -> bool:
        return True

    def _refresh_config(self) -> None:
        if self._config_loader is None:
            return
        try:
            self.config = self._config_loader()
        except Exception:
            logger.exception("Failed to refresh LightRAG config")

    def _get_live_config(self) -> LightRagToolConfig:
        """Lazily reload config for hot-reload support."""
        self._refresh_config()
        return self.config

    def runtime_context_provider(self):
        return self._provide_runtime_context

    async def _provide_runtime_context(self, request: RequestContext) -> RuntimeContextBlock | None:
        """Steer the LLM to recall from the active knowledge base this turn."""
        if not request.original_user_text:
            return None

        config = self._get_live_config()
        if not config.enabled:
            lines = [
                "LightRAG recall: disabled (integration disabled in settings). "
                "Do not call lightrag_query."
            ]
        else:
            scope = self._scope_description(request)
            if scope:
                lines = [
                    f"LightRAG knowledge base active for this turn (scope: {scope}). "
                    "For questions that could be informed by this indexed knowledge, "
                    "call the lightrag_query tool first (with the user's question as `query`) before answering.",
                    "When lightrag_query returns references:",
                    "- Numbered document links (e.g. `1. [📄Document title](...)`) are source/document citations; keep them as document links.",
                    "- `Image context:` text is the indexed VLM description of a retrieved image; you may use it as visual understanding without calling another image model.",
                    "- Unnumbered Markdown image lines (e.g. `![name](/api/lightrag/file/proj/image.png)`) are renderable retrieved media; preserve them when the answer should show the image.",
                    "- Do not turn a parent document link into an image, and do not add image lines to the document-reference list manually.",
                ]
            else:
                lines = [
                    "LightRAG recall: disabled (no knowledge base selected). "
                    "Do not call lightrag_query."
                ]

        content = wrap_runtime_context_lines(lines)
        if not content:
            return None
        return RuntimeContextBlock(source="lightrag", content=content)

    def _targets_from_names(
        self,
        names: list[str],
        config: LightRagToolConfig,
    ) -> list[LightRagServerConfig]:
        by_name = {server.name: server for server in config.servers}
        targets: list[LightRagServerConfig] = []
        for name in names:
            server = by_name.get(name)
            if server is None or server in targets:
                continue
            targets.append(server)
        return targets

    def _resolve_target_servers_for_request(
        self,
        request: RequestContext | None,
    ) -> list[LightRagServerConfig]:
        config = self._get_live_config()
        if request is not None and request.metadata.get("webui") is True:
            names = [
                name
                for name in normalize_lightrag_workspaces(request.metadata.get("lightrag_workspaces"))
                if name != _DEFAULT_SENTINEL
            ]
            return self._targets_from_names(names, config)

        default = (config.default_workspace or "").strip()
        if not default:
            return []
        return self._targets_from_names([default], config)

    def _resolve_target_servers(self) -> list[LightRagServerConfig]:
        """Resolve which servers to query based on the current request."""
        return self._resolve_target_servers_for_request(current_request_context())

    def _scope_description(self, request: RequestContext | None) -> str:
        targets = self._resolve_target_servers_for_request(request)
        return ", ".join(server.name for server in targets)

    def _format_server_section(
        self,
        server_name: str,
        data: dict[str, Any],
        include_refs: bool,
        api_base: str = "",
        api_key: str | None = None,
    ) -> str:
        response = str(data.get("response") or "").strip()
        lines = [f"## Knowledge Base: {server_name}"]
        if response:
            lines.append(response)

        if include_refs and isinstance(data.get("references"), list):
            for i, ref in enumerate(data.get("references"), 1):
                if not isinstance(ref, dict):
                    continue
                path = str(ref.get("file_path") or ref.get("path") or "")
                rid = _md_safe_text(str(ref.get("reference_id") or ref.get("id") or "").strip())
                if path:
                    display_name = str(ref.get("display_name") or "").strip()
                    if not display_name:
                        display_name = _reference_display_name(path)
                    if api_base:
                        file_url = _gateway_file_url(server_name, path)
                        head = f"{i}. [{_md_safe_text(display_name)}]({file_url})" + (
                            f" (id:{rid})" if rid else ""
                        )
                    else:
                        head = f"{i}. {_md_safe_text(display_name)}" + (
                            f" (id:{rid})" if rid else ""
                        )
                else:
                    head = f"{i}. {rid or ''}".strip()
                lines.append(head)
                content = ref.get("content")
                if isinstance(content, list) and content:
                    lines.append("   " + "\n   ".join(_md_safe_text(str(c)) for c in content if c))
                elif isinstance(content, str) and content:
                    lines.append(f"   {_md_safe_text(content)}")
                # Retrieved media context: expose the indexed VLM description
                # and one unnumbered Markdown image line per media item.  The
                # image lines stay indented and unnumbered so the WebUI's
                # document-reference extractor only classifies the parent
                # link (above) as a document reference.
                media_list = ref.get("media")
                if isinstance(media_list, list):
                    for media_item in media_list:
                        if not isinstance(media_item, dict):
                            continue
                        if str(media_item.get("type") or "") != "image":
                            continue
                        media_path = str(media_item.get("path") or "").strip()
                        if not media_path:
                            continue
                        media_name = _md_safe_text(
                            str(media_item.get("name") or "").strip()
                        )
                        media_desc = _md_safe_text(
                            str(media_item.get("description") or "").strip()
                        )
                        if media_name or media_desc:
                            context = (
                                f"{media_name}。{media_desc}"
                                if media_name and media_desc
                                else (media_name or media_desc)
                            )
                            lines.append(f"   Image context: {context}")
                        if api_base:
                            media_url = _gateway_file_url(server_name, media_path)
                            label = media_name or _md_safe_text(media_path)
                            lines.append(f"   ![{label}]({media_url})")
                        else:
                            # Without a gateway URL the media path is still
                            # surfaced as plain metadata for the model.
                            lines.append(f"   Image media: {_md_safe_text(media_path)}")
        return "\n".join(lines).strip()

    async def _query_one(
        self,
        server: LightRagServerConfig,
        query: str,
        mode: str | None,
        top_k: int | None,
        only_need_context: bool | None,
        include_references: bool | None,
    ) -> ToolResult:
        ok, err = validate_url_target(server.api_base, allow_loopback=True)
        if not ok:
            return _server_error(server.name, f"invalid api_base - {err}")

        effective_mode = mode or server.default_query_mode
        inc_refs = server.include_references if include_references is None else include_references

        body: dict[str, Any] = {
            "query": query,
            "mode": effective_mode,
            "include_references": inc_refs,
        }
        if top_k is not None:
            body["top_k"] = top_k
        elif server.default_top_k is not None:
            body["top_k"] = server.default_top_k

        if only_need_context is not None:
            body["only_need_context"] = only_need_context
        if inc_refs and server.include_chunk_content:
            body["include_chunk_content"] = True

        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        api_key = server.api_key or os.environ.get("LIGHTRAG_API_KEY", "")
        if api_key:
            headers["X-API-Key"] = api_key

        kwargs: dict[str, Any] = {"timeout": server.timeout}
        if server.proxy:
            kwargs["proxy"] = server.proxy
        else:
            kwargs["transport"] = PinnedDNSAsyncTransport(allow_loopback=True)
            mounts = httpx_env_proxy_mounts()
            if mounts:
                kwargs["mounts"] = mounts

        url = f"{server.api_base.rstrip('/')}/query"

        try:
            async with httpx.AsyncClient(**kwargs) as client:
                r = await client.post(url, headers=headers, json=body)
                if r.status_code != 200:
                    return _server_error(
                        server.name,
                        f"query failed with {r.status_code} - {r.text[:100]}",
                    )
                try:
                    data = r.json()
                except Exception as exc:
                    return _server_error(server.name, f"non-JSON - {exc}")
                if not isinstance(data, dict):
                    return _server_error(server.name, "unexpected payload")
                return ToolResult(
                    self._format_server_section(
                        server.name,
                        data,
                        inc_refs,
                        api_base=server.api_base,
                        api_key=server.api_key,
                    )
                )
        except httpx.RequestError as exc:
            logger.warning("LightRAG query failed for {}: {}", server.name, exc)
            return _server_error(server.name, f"request failed - {exc}")
        except Exception as exc:
            logger.warning("LightRAG query failed for {}: {}", server.name, exc)
            return _server_error(server.name, f"unhandled internal exception - {exc}")

    async def execute(
        self,
        query: str,
        mode: str | None = None,
        top_k: int | None = None,
        only_need_context: bool | None = None,
        include_references: bool | None = None,
        **kwargs: Any,
    ) -> str:
        config = self._get_live_config()
        if not config.enabled:
            return _DISABLED_MESSAGE

        if mode is not None and mode not in _QUERY_MODES:
            return ToolResult.error(
                f"Error: mode must be one of {_QUERY_MODES}, got {mode!r}"
            )

        targets = self._resolve_target_servers()
        if not targets:
            return _SKIP_MESSAGE

        # Multi-server fan-out returns raw context so the main LLM synthesizes once.
        if len(targets) > 1:
            only_need_context = True

        results = await asyncio.gather(
            *(
                self._query_one(
                    server,
                    query,
                    mode,
                    top_k,
                    only_need_context,
                    include_references,
                )
                for server in targets
            ),
            return_exceptions=True,
        )

        sections: list[ToolResult] = []
        for server, result in zip(targets, results):
            if isinstance(result, Exception):
                sections.append(_server_error(server.name, f"unhandled internal exception - {result}"))
            else:
                sections.append(result)

        merged = "\n\n".join(str(section) for section in sections).strip() or "(no response)"
        if all(section.is_error for section in sections):
            return ToolResult.error(merged)
        return merged
