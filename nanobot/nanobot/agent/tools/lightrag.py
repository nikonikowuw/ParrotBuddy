"""LightRAG vector-graph retrieval tool.

Calls a LightRAG Server (https://github.com/HKUDS/LightRAG) REST API to
perform vector-graph hybrid retrieval. v1 targets the ``POST /query``
endpoint (synthesized answer + source references).

Recall scope is NOT chosen by the LLM. It is driven by the user's UI
selection (per-turn ``RequestContext.metadata['lightrag_workspaces']``) for
WebUI turns, or by ``config.default_workspace`` for CLI turns. The LLM only
passes ``query`` (plus optional recall knobs); the tool fans out over the
active workspace set automatically.

Workspace selection follows the server's multi-workspace contract: a single
workspace name per request, sent via the ``LIGHTRAG-WORKSPACE`` header and
validated server-side against the ``WORKSPACES`` allowlist. The UI "Default"
item is carried as the ``__default__`` sentinel and maps to "no header"
(server default).
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Literal

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

_QUERY_MODES = ("local", "global", "hybrid", "naive", "mix", "bypass")
_WORKSPACE_HEADER = "LIGHTRAG-WORKSPACE"
# UI sentinel marking "use the server default workspace" (no header). Carried
# in ``metadata['lightrag_workspaces']`` alongside named workspaces; the tool
# resolves it to ``[None]`` (no LIGHTRAG-WORKSPACE header).
_DEFAULT_SENTINEL = "__default__"
_SKIP_MESSAGE = "No knowledge base selected; recall skipped."


def _parse_workspace_names(raw: Any) -> list[str]:
    """Extract trimmed workspace names from a raw metadata value (defensive)."""
    if not isinstance(raw, (list, tuple)):
        return []
    return [str(w).strip() for w in raw if str(w).strip()]


class LightRagToolConfig(Base):
    """LightRAG retrieval tool configuration."""

    enabled: bool = False
    api_base: str = "http://127.0.0.1:9621"
    api_key: str | None = None  # sent as X-API-Key; supports ${LIGHTRAG_API_KEY}
    default_query_mode: Literal["local", "global", "hybrid", "naive", "mix", "bypass"] = "mix"
    default_top_k: int | None = Field(default=None, ge=1, le=100)  # None = server default
    workspaces: list[str] = Field(default_factory=list)  # allowlist; UI options + validation
    default_workspace: str | None = None  # CLI-only fallback scope (WebUI is UI-driven)
    timeout: float = 60.0
    proxy: str | None = None
    include_references: bool = True
    include_chunk_content: bool = False


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema(
            "Retrieval query: a natural-language question or keywords.",
            min_length=3,
        ),
        mode=StringSchema(
            "Retrieval mode. local=entity-centric, global=community-level, "
            "hybrid=both, naive=flat vector, mix=hybrid+naive (default), "
            "bypass=skip retrieval (direct LLM). Omit to use configured default.",
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
    """Query a LightRAG Server for vector-graph hybrid retrieval."""

    config_key = "lightrag"
    _scopes = {"core", "subagent"}

    name = "lightrag_query"
    description = (
        "Retrieve knowledge from a LightRAG vector store (vector-graph hybrid recall). "
        "Returns a synthesized answer and source references. "
        "Recall scope (which knowledge bases to query) is determined by the user's UI "
        "selection or the configured default — do NOT try to choose a knowledge base "
        "yourself. Set only_need_context=true to get raw retrieved context without "
        "synthesis. Use mode to steer recall scope (local/global/hybrid/naive/mix/bypass)."
    )

    @classmethod
    def config_cls(cls):
        return LightRagToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.lightrag.enabled

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(config=ctx.config.lightrag)

    def __init__(self, config: LightRagToolConfig | None = None) -> None:
        self.config = config if config is not None else LightRagToolConfig()
        self._base_ok: bool | None = None
        self._base_error: str = ""

    @property
    def read_only(self) -> bool:
        return True

    def runtime_context_provider(self):
        return self._provide_runtime_context

    async def _provide_runtime_context(
        self,
        request: RequestContext,
    ) -> RuntimeContextBlock | None:
        """Steer the LLM to recall from the active knowledge base this turn.

        Directive phrasing (modeled on ``goal_runtime.md`` / ``cli_apps`` blocks)
        is acceptable here: the block is self-generated by our own tool, not
        untrusted fetched content, so the ``[Runtime Context]`` "metadata only"
        anti-injection tag does not bar behavioral guidance.
        """
        # Continuation / internal turns (no user text) → stay silent.
        if not request.original_user_text:
            return None

        scope = self._scope_description(request)
        if scope:
            lines = [
                f"LightRAG knowledge base active for this turn (scope: {scope}). "
                "For questions that could be informed by this indexed knowledge, "
                "call the lightrag_query tool first (with the user's question as "
                "`query`) before answering — do not wait for the user to mention "
                "RAG. Skip the call for conversational messages or questions "
                "clearly unrelated to the knowledge base."
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

    def _scope_description(self, request: RequestContext | None) -> str:
        """Human-readable active scope label (mirrors _resolve_workspace_set)."""
        if request is not None and request.metadata.get("webui") is True:
            names = _parse_workspace_names(request.metadata.get("lightrag_workspaces"))
            if _DEFAULT_SENTINEL in names:
                return "server default"
            if names:
                return ", ".join(names)
            return ""
        default = (self.config.default_workspace or "").strip()
        return default

    def _resolve_api_key(self) -> str:
        return self.config.api_key or os.environ.get("LIGHTRAG_API_KEY", "")

    def _validate_base(self) -> tuple[bool, str]:
        if self._base_ok is None:
            ok, err = validate_url_target(self.config.api_base, allow_loopback=True)
            self._base_ok = ok
            self._base_error = err
        return self._base_ok, self._base_error

    def _validate_workspace(self, workspace: str) -> str:
        """Validate a single named workspace against the configured allowlist."""
        allow = self.config.workspaces
        if allow and workspace not in allow:
            raise ValueError(
                f"workspace {workspace!r} not in configured allowlist {allow}"
            )
        return workspace

    def _resolve_workspace_set(self) -> list[str | None]:
        """Resolve the active workspace set for this call.

        Returns a list where:
        - ``[]``  → skip recall (no scope selected / configured).
        - ``[None]`` → server default (no ``LIGHTRAG-WORKSPACE`` header).
        - ``["a", "b"]`` → fan-out over those named workspaces.

        WebUI turns are scope-aware via ``RequestContext.metadata``; CLI falls
        back to ``config.default_workspace``.
        """
        ctx = current_request_context()
        if ctx is not None and ctx.metadata.get("webui") is True:
            names = _parse_workspace_names(ctx.metadata.get("lightrag_workspaces"))
            if _DEFAULT_SENTINEL in names:
                return [None]  # UI "Default" → server default, no header
            seen: list[str | None] = []
            for name in names:
                if name and name not in seen:
                    seen.append(self._validate_workspace(name))
            return seen

        # CLI / non-WebUI: config default_workspace
        default = (self.config.default_workspace or "").strip()
        if default:
            return [self._validate_workspace(default)]
        return []

    def _client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"timeout": self.config.timeout}
        if self.config.proxy:
            kwargs["proxy"] = self.config.proxy
        else:
            kwargs["transport"] = PinnedDNSAsyncTransport(allow_loopback=True)
            mounts = httpx_env_proxy_mounts()
            if mounts:
                kwargs["mounts"] = mounts
        return kwargs

    def _format_workspace_section(
        self, ws: str | None, data: dict[str, Any], include_refs: bool
    ) -> str:
        response = str(data.get("response") or "").strip()
        refs = data.get("references") if include_refs else None
        if not isinstance(refs, list):
            refs = None
        lines: list[str] = []
        heading = f"Workspace: {ws}" if ws else "Workspace: (default)"
        lines.append(f"## {heading}")
        if response:
            lines.append(response)
        if refs:
            for i, ref in enumerate(refs, 1):
                if not isinstance(ref, dict):
                    continue
                rid = str(ref.get("reference_id") or ref.get("id") or "")
                path = str(ref.get("file_path") or ref.get("path") or "")
                if path and rid:
                    head = f"{i}. {path} (id:{rid})"
                elif path:
                    head = f"{i}. {path}"
                elif rid:
                    head = f"{i}. (id:{rid})"
                else:
                    head = f"{i}."
                lines.append(head)
                content = ref.get("content")
                if isinstance(content, list) and content:
                    lines.append("   " + "\n   ".join(str(c) for c in content if c))
                elif isinstance(content, str) and content:
                    lines.append(f"   {content}")
        return "\n".join(lines).strip()

    async def _query_one(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers_base: dict[str, str],
        body: dict[str, Any],
        ws: str | None,
        include_refs: bool,
    ) -> tuple[str | None, str | None]:
        """Issue one /query request. Returns ``(success_section, error_message)``.

        Exactly one element is non-None: a formatted section on success, or an
        error description on failure (used by the single-workspace path to build
        a ``ToolResult.error`` and by the multi-workspace path to degrade
        gracefully per workspace).
        """
        headers = dict(headers_base)
        if ws:
            headers[_WORKSPACE_HEADER] = ws
        label = ws or "(default)"
        try:
            r = await client.post(url, headers=headers, json=body)
        except httpx.RequestError as exc:
            logger.warning("LightRAG query failed for workspace {}: {}", label, exc)
            return None, f"request failed: {exc}"
        if r.status_code != 200:
            return None, f"query failed ({r.status_code}): {r.text[:200]}"
        try:
            data = r.json()
        except Exception as exc:
            return None, f"non-JSON: {exc}"
        if not isinstance(data, dict):
            return None, "unexpected payload"
        return self._format_workspace_section(ws, data, include_refs), None

    async def execute(
        self,
        query: str,
        mode: str | None = None,
        top_k: int | None = None,
        only_need_context: bool | None = None,
        include_references: bool | None = None,
        **kwargs: Any,
    ) -> str:
        ok, err = self._validate_base()
        if not ok:
            return ToolResult.error(f"Error: LightRAG api_base invalid: {err}")

        try:
            workspace_set = self._resolve_workspace_set()
        except ValueError as exc:
            return ToolResult.error(f"Error: {exc}")

        if not workspace_set:
            # No scope selected (WebUI) and no configured default (CLI).
            return _SKIP_MESSAGE

        effective_mode = mode or self.config.default_query_mode
        if effective_mode not in _QUERY_MODES:
            return ToolResult.error(
                f"Error: mode must be one of {_QUERY_MODES}, got {effective_mode!r}"
            )

        inc_refs = (
            self.config.include_references if include_references is None else include_references
        )

        body: dict[str, Any] = {"query": query, "mode": effective_mode, "include_references": inc_refs}
        if top_k is not None:
            body["top_k"] = top_k
        elif self.config.default_top_k is not None:
            body["top_k"] = self.config.default_top_k
        if inc_refs and self.config.include_chunk_content:
            body["include_chunk_content"] = True

        # Multi-workspace fan-out: force raw-context recall (no per-workspace LLM
        # synthesis) so the agent's LLM synthesizes once across all sources.
        single = len(workspace_set) <= 1
        if not single:
            body["only_need_context"] = True
        elif only_need_context is not None:
            body["only_need_context"] = only_need_context

        headers_base: dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        api_key = self._resolve_api_key()
        if api_key:
            headers_base["X-API-Key"] = api_key

        url = f"{self.config.api_base.rstrip('/')}/query"
        try:
            async with httpx.AsyncClient(**self._client_kwargs()) as client:
                if single:
                    ws0 = workspace_set[0]
                    section, error = await self._query_one(
                        client, url, headers_base, body, ws0, inc_refs
                    )
                    if error:
                        return ToolResult.error(f"Error: LightRAG {error}")
                    return section or "(no response)"

                results = await asyncio.gather(
                    *(
                        self._query_one(client, url, headers_base, body, ws, inc_refs)
                        for ws in workspace_set
                    )
                )
        except httpx.RequestError as exc:
            logger.warning("LightRAG query request failed: {}", exc)
            return ToolResult.error(f"Error: LightRAG request failed: {exc}")

        sections: list[str] = []
        for ws, (section, error) in zip(workspace_set, results):
            label = ws or "(default)"
            if error:
                sections.append(f"## Workspace: {label}\n(error: {error})")
            elif section:
                sections.append(section)
        merged = "\n\n".join(sections)
        return merged.strip() or "(no response)"
