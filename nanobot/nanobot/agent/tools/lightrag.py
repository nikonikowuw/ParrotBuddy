"""LightRAG vector-graph retrieval tool (multi-server aggregation)."""

from __future__ import annotations

import asyncio
import math
import os
import re
from collections.abc import Callable
from typing import Any, Literal
from urllib.parse import parse_qsl, quote, urlsplit

import httpx
from loguru import logger
from pydantic import AliasChoices, Field, model_validator

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
# Built-in personal knowledge base identifier.
PERSONAL_KB_IDENTIFIER = "__personal__"
_PERSONAL_KB_SENTINEL = PERSONAL_KB_IDENTIFIER
_SKIP_MESSAGE = "No knowledge base selected; recall skipped."
_DISABLED_MESSAGE = "LightRAG knowledge base integration is disabled; recall skipped."


def is_reserved_lightrag_server_name(
    name: str,
    personal_name: str | None = None,
) -> bool:
    """Return whether an enterprise name would collide with a built-in target."""
    normalized = name.strip()
    reserved = {PERSONAL_KB_IDENTIFIER}
    if personal_name:
        configured_name = personal_name.strip()
        if configured_name:
            reserved.add(configured_name)
    return normalized in reserved


def _server_error(name: str | None, message: str) -> ToolResult:
    """Build a per-server error section for fan-out results."""
    heading = f"## Knowledge Base: {name}" if name else "## Knowledge Base"
    return ToolResult.error(f"{heading}\n(error: {message})")


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


_REFERENCE_URL_QUERY_KEYS = frozenset(
    {"access_token", "api_key", "apikey", "authorization", "token", "x_api_key"}
)
_MAX_REFERENCE_TEXT_CHARS = 8_000
_MAX_REFERENCE_ITEMS = 100


def _safe_document_path(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    path = value.strip().replace("\\", "/")
    if not path or "\x00" in path or any(part == ".." for part in path.split("/")):
        return None
    return path


def _safe_media_path(value: Any) -> str | None:
    path = _safe_document_path(value)
    if not path or path.startswith("/") or re.match(r"^[A-Za-z]:/", path):
        return None
    return path


def _safe_external_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return None
    if parsed.username or parsed.password:
        return None
    for query in (parsed.query, parsed.fragment):
        for key, _ in parse_qsl(query, keep_blank_values=True):
            if key.lower().replace("-", "_") in _REFERENCE_URL_QUERY_KEYS:
                return None
    return value


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _bounded_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:_MAX_REFERENCE_TEXT_CHARS] if value else None


def _normalize_reference(
    reference: Any,
    server_name: str,
    server_label: str | None = None,
) -> dict[str, Any] | None:
    if not isinstance(reference, dict):
        return None
    file_path = _safe_document_path(reference.get("file_path") or reference.get("path"))
    if not file_path:
        return None
    normalized: dict[str, Any] = {
        "reference_id": str(reference.get("reference_id") or reference.get("id") or ""),
        "file_path": file_path,
        "server_name": server_name,
    }
    if server_label and server_label != server_name:
        normalized["server_label"] = server_label[:256]
    title = _bounded_text(reference.get("title") or reference.get("display_name"))
    if title:
        normalized["title"] = title
    source_url = _safe_external_url(reference.get("source_url"))
    if source_url:
        normalized["source_url"] = source_url

    hit_count = reference.get("hit_count")
    if isinstance(hit_count, int) and not isinstance(hit_count, bool) and hit_count >= 1:
        normalized["hit_count"] = hit_count
    best_score = _finite_number(reference.get("best_score"))
    if best_score is not None:
        normalized["best_score"] = best_score
    best_score_type = reference.get("best_score_type")
    if isinstance(best_score_type, str) and best_score_type:
        normalized["best_score_type"] = best_score_type[:64]

    raw_chunks = reference.get("chunks")
    if isinstance(raw_chunks, list):
        chunks: list[dict[str, Any]] = []
        for raw_chunk in raw_chunks[:_MAX_REFERENCE_ITEMS]:
            if not isinstance(raw_chunk, dict):
                continue
            chunk_id = str(raw_chunk.get("chunk_id") or raw_chunk.get("id") or "")
            if not chunk_id:
                continue
            chunk: dict[str, Any] = {"chunk_id": chunk_id}
            content = _bounded_text(raw_chunk.get("content"))
            if content is not None:
                chunk["content"] = content
            for key in ("score", "rerank_score", "vector_score", "distance"):
                value = _finite_number(raw_chunk.get(key))
                if value is not None:
                    chunk[key] = value
            score_type = raw_chunk.get("score_type")
            if isinstance(score_type, str) and score_type:
                chunk["score_type"] = score_type[:64]
            rank = raw_chunk.get("retrieval_rank")
            if isinstance(rank, int) and not isinstance(rank, bool) and rank >= 1:
                chunk["retrieval_rank"] = rank
            chunks.append(chunk)
        if chunks:
            normalized["chunks"] = chunks

    raw_content = reference.get("content")
    if isinstance(raw_content, list):
        content = [item for item in (_bounded_text(value) for value in raw_content) if item]
        if content:
            normalized["content"] = content[:_MAX_REFERENCE_ITEMS]
    elif (content := _bounded_text(raw_content)) is not None:
        normalized["content"] = [content]

    raw_media = reference.get("media")
    if isinstance(raw_media, list):
        media: list[dict[str, Any]] = []
        seen_media: set[str] = set()
        for raw_item in raw_media[:_MAX_REFERENCE_ITEMS]:
            if not isinstance(raw_item, dict) or raw_item.get("type") != "image":
                continue
            path = _safe_media_path(raw_item.get("path"))
            if not path or path in seen_media:
                continue
            seen_media.add(path)
            item: dict[str, Any] = {"type": "image", "path": path}
            for key in ("format", "name", "description"):
                value = _bounded_text(raw_item.get(key))
                if value:
                    item[key] = value
            media.append(item)
        if media:
            normalized["media"] = media
    return normalized


def _normalize_references(
    references: Any,
    server_name: str,
    server_label: str | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(references, list):
        return []
    return [
        normalized
        for reference in references[:_MAX_REFERENCE_ITEMS]
        if (
            normalized := _normalize_reference(
                reference,
                server_name,
                server_label,
            )
        ) is not None
    ]


def _reference_evidence_summary(
    references: list[dict[str, Any]],
) -> dict[str, Any]:
    scores: list[tuple[float, str]] = []
    chunk_count = 0
    for reference in references:
        chunks = reference.get("chunks")
        if isinstance(chunks, list):
            chunk_count += len(chunks)
        elif isinstance(reference.get("hit_count"), int):
            chunk_count += max(reference["hit_count"], 0)
        score = _finite_number(reference.get("best_score"))
        score_type = reference.get("best_score_type")
        if score is not None and isinstance(score_type, str) and score_type:
            scores.append((score, score_type))
    summary: dict[str, Any] = {
        "has_evidence": bool(references),
        "reference_count": len(references),
        "chunk_count": chunk_count,
    }
    if scores:
        best_score, score_type = max(scores, key=lambda item: item[0])
        summary["best_score"] = best_score
        summary["best_score_type"] = score_type
    return summary


def _attach_reference_evidence(
    result: ToolResult,
    references: list[dict[str, Any]],
) -> ToolResult:
    if references:
        result.references = references
    result.evidence_summary = _reference_evidence_summary(references)
    return result


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


class LightRagPersonalConfig(Base):
    """Configuration for the built-in personal knowledge base."""
    enabled: bool = True
    name: str | None = None  # Optional display-name override; UI localizes the default.
    api_base: str = "http://127.0.0.1:9621"
    api_key: str | None = None
    default_query_mode: Literal["local", "global", "hybrid", "naive", "mix", "bypass"] = "mix"
    default_top_k: int | None = Field(default=None, ge=1, le=100)
    timeout: float = Field(default=60.0, gt=0)
    proxy: str | None = None
    include_references: bool = True
    include_chunk_content: bool = False


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
    personal: LightRagPersonalConfig = Field(default_factory=LightRagPersonalConfig)
    enterprise_servers: list[LightRagServerConfig] = Field(
        default_factory=list,
        validation_alias=AliasChoices("enterprise_servers", "enterpriseServers", "servers"),
    )
    default_workspace: str | None = None  # CLI-only fallback

    @model_validator(mode="after")
    def _validate_enterprise_server_names(self) -> "LightRagToolConfig":
        for server in self.enterprise_servers:
            if is_reserved_lightrag_server_name(server.name, self.personal.name):
                raise ValueError(f"enterprise server name is reserved: {server.name!r}")
        return self

    @property
    def servers(self) -> list[LightRagServerConfig]:
        """Backward-compatible alias for enterprise_servers."""
        return self.enterprise_servers

    @servers.setter
    def servers(self, value: list[LightRagServerConfig]) -> None:
        self.enterprise_servers = value


def configured_lightrag_servers(
    config: LightRagToolConfig,
) -> list[LightRagServerConfig]:
    """Return enterprise servers plus the enabled personal target."""
    enterprise_servers = getattr(config, "enterprise_servers", None)
    if not isinstance(enterprise_servers, list):
        enterprise_servers = getattr(config, "servers", [])
    servers = list(enterprise_servers or [])
    personal = getattr(config, "personal", None)
    if personal is not None and getattr(personal, "enabled", False) is True:
        servers.append(
            LightRagServerConfig(
                name=PERSONAL_KB_IDENTIFIER,
                api_base=personal.api_base,
                api_key=personal.api_key,
                default_query_mode=personal.default_query_mode,
                default_top_k=personal.default_top_k,
                timeout=personal.timeout,
                proxy=personal.proxy,
                include_references=personal.include_references,
                include_chunk_content=personal.include_chunk_content,
            )
        )
    return servers


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

    def _server_display_name(
        self,
        server: LightRagServerConfig,
        config: LightRagToolConfig,
    ) -> str | None:
        if server.name == PERSONAL_KB_IDENTIFIER:
            name = (config.personal.name or "").strip()
            return name or None
        return server.name

    def _targets_from_names(
        self,
        names: list[str],
        config: LightRagToolConfig,
    ) -> list[LightRagServerConfig]:
        by_name = {server.name: server for server in configured_lightrag_servers(config)}
        personal_server = by_name.get(PERSONAL_KB_IDENTIFIER)
        personal_name = (config.personal.name or "").strip()
        if personal_server and personal_name:
            by_name[personal_name] = personal_server

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
        config = self._get_live_config()
        targets = self._resolve_target_servers_for_request(request)
        return ", ".join(
            self._server_display_name(server, config) or server.name
            for server in targets
        )

    def _format_server_section(
        self,
        server_name: str,
        data: dict[str, Any],
        include_refs: bool,
        api_base: str = "",
        api_key: str | None = None,
        references: list[dict[str, Any]] | None = None,
        server_label: str | None = None,
    ) -> str:
        response = str(data.get("response") or "").strip()
        lines: list[str] = []
        if server_label or server_name != PERSONAL_KB_IDENTIFIER:
            lines.append(f"## Knowledge Base: {server_label or server_name}")
        if response:
            lines.append(response)

        if references is None:
            references = _normalize_references(
                data.get("references") if include_refs else None,
                server_name,
                server_label,
            )
        if include_refs:
            for i, ref in enumerate(references, 1):
                path = ref["file_path"]
                rid = _md_safe_text(str(ref.get("reference_id") or "").strip())
                display_name = str(ref.get("title") or "").strip() or _reference_display_name(path)
                source_url = ref.get("source_url")
                if source_url:
                    citation_url = source_url
                elif api_base:
                    citation_url = _gateway_file_url(server_name, path)
                else:
                    citation_url = ""
                if citation_url:
                    head = f"{i}. [{_md_safe_text(display_name)}]({citation_url})" + (
                        f" (id:{rid})" if rid else ""
                    )
                else:
                    head = f"{i}. {_md_safe_text(display_name)}" + (
                        f" (id:{rid})" if rid else ""
                    )
                lines.append(head)
                content_values = ref.get("content")
                if not isinstance(content_values, list):
                    content_values = [
                        chunk.get("content")
                        for chunk in ref.get("chunks", [])
                        if isinstance(chunk, dict) and chunk.get("content")
                    ]
                if content_values:
                    lines.append(
                        "   "
                        + "\n   ".join(
                            _md_safe_text(str(content))
                            for content in content_values
                            if content
                        )
                    )
                # Media remains nested under the parent document. Its path is
                # a relative locator, never a replacement for ``file_path``.
                for media_item in ref.get("media", []):
                    media_path = _safe_media_path(media_item.get("path"))
                    if not media_path:
                        continue
                    media_name = _md_safe_text(str(media_item.get("name") or "").strip())
                    media_desc = _md_safe_text(str(media_item.get("description") or "").strip())
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
        server_label: str | None = None,
    ) -> ToolResult:
        display_name = server_label or (
            None if server.name == PERSONAL_KB_IDENTIFIER else server.name
        )
        ok, err = validate_url_target(server.api_base, allow_loopback=True)
        if not ok:
            return _server_error(display_name, f"invalid api_base - {err}")

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
                        display_name,
                        f"query failed with {r.status_code} - {r.text[:100]}",
                    )
                try:
                    data = r.json()
                except Exception as exc:
                    return _server_error(display_name, f"non-JSON - {exc}")
                if not isinstance(data, dict):
                    return _server_error(display_name, "unexpected payload")
                references = _normalize_references(
                    data.get("references") if inc_refs else None,
                    server.name,
                    server_label,
                )

                result = ToolResult(
                    self._format_server_section(
                        server.name,
                        data,
                        inc_refs,
                        api_base=server.api_base,
                        api_key=server.api_key,
                        references=references,
                        server_label=server_label,
                    )
                )
                return _attach_reference_evidence(result, references)
        except httpx.RequestError as exc:
            logger.warning("LightRAG query failed for {}: {}", server.name, exc)
            return _server_error(display_name, f"request failed - {exc}")
        except Exception as exc:
            logger.warning("LightRAG query failed for {}: {}", server.name, exc)
            return _server_error(
                display_name,
                f"unhandled internal exception - {exc}",
            )

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
                    self._server_display_name(server, config),
                )
                for server in targets
            ),
            return_exceptions=True,
        )

        sections: list[ToolResult] = []
        references: list[dict[str, Any]] = []
        for server, result in zip(targets, results):
            if isinstance(result, Exception):
                server_label = self._server_display_name(server, config)
                section = _server_error(
                    server_label,
                    f"unhandled internal exception - {result}",
                )
            else:
                section = result
            sections.append(section)
            section_references = getattr(section, "references", None)
            if isinstance(section_references, list):
                references.extend(section_references)

        merged = "\n\n".join(str(section) for section in sections).strip() or "(no response)"
        if all(section.is_error for section in sections):
            return ToolResult.error(merged)
        result = ToolResult(merged)
        return _attach_reference_evidence(result, references)
