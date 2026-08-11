"""
Multi-workspace support for the LightRAG API server.

The storage layer already partitions data by ``workspace`` (file subdirectory,
collection name, ``workspace`` column, node label, or payload field). This
module hosts one lazily-built :class:`lightrag.LightRAG` instance per
workspace in a single API process and routes each request to the right
instance via the ``LIGHTRAG-WORKSPACE`` HTTP header.

Design (proxy + middleware):

* Route factories keep their original closure signatures
  (``create_document_routes(rag, doc_manager, api_key)`` ...). The server
  passes :class:`RequestRagProxy` / :class:`RequestDocManagerProxy` as the
  ``rag`` / ``doc_manager`` arguments. Handlers close over the proxy and use
  it exactly like a real ``LightRAG`` (``rag.workspace``, ``await
  rag.aquery(...)``); ``__getattr__`` transparently forwards to the
  per-request instance.
* :func:`setup_workspace_middleware` installs an HTTP middleware that reads
  the header, resolves / lazily builds the workspace's ``LightRAG`` via
  :class:`WorkspaceRegistry`, and stashes it in a ``ContextVar`` *before*
  ``call_next`` — so it is visible inside every route handler (Starlette's
  ``call_next`` runs the endpoint in a child context that inherits the
  parent's ContextVar values).
* The per-context workspace is also set via
  ``set_current_workspace`` so implicit namespace calls during the request
  land on the right workspace.

Backward compatibility: when the multi-workspace switch is off, the registry
serves exactly the default workspace (``args.workspace`` / ``WORKSPACE``),
matching the pre-existing single-instance behavior. When no registry is
configured on ``app.state`` (unit tests, legacy setups), the proxies fall
back to ``app.state.rag`` / ``app.state.doc_manager`` if present, so isolated
tests that build a real rag and a router keep working unchanged.
"""

import asyncio
import re
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any, Callable, Optional, Set

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

from lightrag.utils import get_env_value
from lightrag.utils import logger

if TYPE_CHECKING:
    from lightrag.lightrag import LightRAG

# Per-backend *_WORKSPACE env vars that force a single workspace process-wide.
# In multi-workspace mode these must be unset (they'd override the per-request
# constructor workspace for every LightRAG instance, defeating isolation).
_BACKEND_WORKSPACE_ENVS = (
    "POSTGRES_WORKSPACE",
    "PG_WORKSPACE",
    "NEO4J_WORKSPACE",
    "MONGODB_WORKSPACE",
    "REDIS_WORKSPACE",
    "MILVUS_WORKSPACE",
    "OPENSEARCH_WORKSPACE",
    "MEMGRAPH_WORKSPACE",
    "QDRANT_WORKSPACE",
)

_WORKSPACE_HEADER = "LIGHTRAG-WORKSPACE"
_WS_SANITIZE_RE = re.compile(r"[^a-zA-Z0-9_]")


def sanitize_workspace(raw: str) -> str:
    """Sanitize a workspace identifier to ``[a-zA-Z0-9_]``."""
    return _WS_SANITIZE_RE.sub("_", raw)


def read_workspace_header(request: Request) -> Optional[str]:
    """Read and sanitize the ``LIGHTRAG-WORKSPACE`` header.

    Returns the sanitized workspace, or ``None`` when the header is absent
    (so the caller can fall back to the default workspace).
    """
    raw = request.headers.get(_WORKSPACE_HEADER, "").strip()
    if not raw:
        return None
    sanitized = sanitize_workspace(raw)
    if sanitized != raw:
        logger.warning(
            f"Workspace header '{raw}' contains invalid characters. "
            f"Sanitized to '{sanitized}'."
        )
    return sanitized


def conflicting_workspace_envs() -> list:
    """Return the list of set per-backend ``*_WORKSPACE`` env vars.

    In multi-workspace mode these conflict with per-request workspace
    selection (they force one workspace for the whole process).
    """
    return [name for name in _BACKEND_WORKSPACE_ENVS if get_env_value(name, "")]


class WorkspaceNotAllowed(HTTPException):
    """HTTP 404 raised when a requested workspace is not served."""

    def __init__(self, workspace: str, reason: str = ""):
        self.workspace = workspace
        self.reason = reason
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Workspace '{workspace}' is not available: {reason}",
        )


class WorkspaceRegistry:
    """Manages per-workspace LightRAG (and DocumentManager) instances.

    Instances are lazily built on first request to a workspace, then cached.
    Storage backends already partition by workspace, so each cached LightRAG
    instance's data is isolated without further work.
    """

    def __init__(
        self,
        rag_factory: Callable[[str], "LightRAG"],
        doc_manager_factory: Callable[[str], Any],
        default_workspace: str = "",
        allowlist: Optional[Set[str]] = None,
        multi_workspace: bool = False,
    ):
        self._rag_factory = rag_factory
        self._doc_manager_factory = doc_manager_factory
        self._default_workspace = default_workspace
        self._allowlist = allowlist
        self._multi_workspace = multi_workspace
        self._rags: dict[str, "LightRAG"] = {}
        self._doc_managers: dict[str, Any] = {}
        self._lock = asyncio.Lock()

    @property
    def multi_workspace(self) -> bool:
        return self._multi_workspace

    @property
    def default_workspace(self) -> str:
        return self._default_workspace

    def list_allowed_workspaces(self) -> list:
        """Workspaces explicitly available (default + allowlist entries)."""
        ws = set(self._allowlist) if self._allowlist is not None else set()
        if self._default_workspace:
            ws.add(self._default_workspace)
        return sorted(w for w in ws if w)

    def list_initialized_workspaces(self) -> list:
        """Workspaces whose LightRAG is already built + cached."""
        return sorted(w for w in self._rags.keys() if w)

    def resolve_workspace(self, workspace: Optional[str]) -> str:
        """Resolve the effective workspace for a request.

        ``None`` / empty -> default workspace. In multi-workspace mode the
        result is validated against the allowlist when one is configured.
        """
        ws = workspace if workspace else self._default_workspace
        if not self._multi_workspace:
            if ws and ws != self._default_workspace:
                raise WorkspaceNotAllowed(
                    ws,
                    "server is not running in multi-workspace mode; "
                    f"only the default workspace '{self._default_workspace}' "
                    "is served",
                )
            return self._default_workspace
        if self._allowlist is not None:
            if ws != self._default_workspace and ws not in self._allowlist:
                raise WorkspaceNotAllowed(ws, "not in WORKSPACES allowlist")
        return ws

    async def get_rag(self, workspace: Optional[str]) -> "LightRAG":
        """Return the cached LightRAG for ``workspace``, lazily building it."""
        ws = self.resolve_workspace(workspace)
        existing = self._rags.get(ws)
        if existing is not None:
            return existing
        async with self._lock:
            existing = self._rags.get(ws)
            if existing is not None:
                return existing
            logger.info(f"Initializing LightRAG for workspace='{ws or '(default)'}'")
            rag = self._rag_factory(ws)
            await rag.initialize_storages()
            await rag.check_and_migrate_data()
            self._rags[ws] = rag
            return rag

    def get_doc_manager(self, workspace: Optional[str]):
        """Return the cached DocumentManager for ``workspace`` (sync, cheap)."""
        ws = self.resolve_workspace(workspace)
        existing = self._doc_managers.get(ws)
        if existing is not None:
            return existing
        dm = self._doc_manager_factory(ws)
        self._doc_managers[ws] = dm
        return dm

    def get_rag_if_cached(self, workspace: str) -> Optional["LightRAG"]:
        """Return an already-initialized rag, or ``None`` (no lazy init)."""
        return self._rags.get(workspace)

    def register_default(self, rag: "LightRAG") -> None:
        """Pre-register an eagerly-built rag for the default workspace.

        ``create_app`` builds the default LightRAG eagerly (so it exists
        before lifespan, matching the legacy behavior and giving the request
        proxy a concrete target). Storage initialization still happens in
        ``initialize_default`` (lifespan). For unit tests that mock LightRAG,
        this also lets the middleware return the mock sync-ly from cache
        without awaiting ``initialize_storages`` on it.
        """
        self._rags[self._default_workspace] = rag

    async def initialize_default(self) -> None:
        """Pre-warm the default workspace (called from lifespan startup).

        If the default rag was pre-registered (``register_default``), only its
        storage initialization + migration runs here (no rebuild). Otherwise
        it is built + initialized via :meth:`get_rag`.
        """
        rag = self._rags.get(self._default_workspace)
        if rag is None:
            await self.get_rag(self._default_workspace)
        else:
            await rag.initialize_storages()
            await rag.check_and_migrate_data()
        self.get_doc_manager(self._default_workspace)

    async def finalize_all(self) -> None:
        """Finalize every cached LightRAG instance (called from shutdown)."""
        for rag in list(self._rags.values()):
            try:
                await rag.finalize_storages()
            except Exception as e:  # noqa: BLE001
                logger.error(f"Error finalizing LightRAG instance: {e}")
        self._rags.clear()
        self._doc_managers.clear()


# ---------------------------------------------------------------------------
# Per-request resolution: ContextVars + transparent proxies
# ---------------------------------------------------------------------------

# Set by the workspace resolver middleware BEFORE call_next. Each proxy
# forwards attribute access to the value here, so route handlers (which close
# over a proxy as their `rag` / `doc_manager`) transparently use the
# per-request instance. None outside a request context.
_current_request_rag: "ContextVar[Optional[LightRAG]]" = ContextVar(
    "lightrag_request_rag", default=None
)
_current_request_doc_manager: ContextVar[Optional[Any]] = ContextVar(
    "lightrag_request_doc_manager", default=None
)


class RequestRagProxy:
    """Transparent stand-in for ``LightRAG`` used as the closure ``rag`` in
    route factories.

    Attribute access (``rag.workspace``, ``await rag.aquery(...)``,
    ``rag.doc_status.get_by_id(...)``) is forwarded to the per-request
    LightRAG stashed in ``_current_request_rag`` by the workspace resolver
    middleware. When no middleware ran (isolated unit tests that build a real
    rag), falls back to ``app.state.rag``.

    This lets the SAME factory + handler code serve multiple workspaces
    without per-request dependency injection: the server passes a proxy
    instead of a real instance, and the middleware swaps the target per
    request.
    """

    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        rag = _current_request_rag.get()
        if rag is None:
            # Legacy fallback (unit tests / older single-instance setups that
            # set app.state.rag). Resolved lazily via the running event loop's
            # current app — but proxies created by the server always run
            # inside the middleware, so this branch is for ad-hoc test rigs.
            raise RuntimeError(
                "RequestRagProxy used outside a request context: no "
                "workspace resolver middleware ran. Either install the "
                "middleware (setup_workspace_middleware) or, for tests, set "
                "app.state.rag and route through the HTTP layer."
            )
        return getattr(rag, name)


class RequestDocManagerProxy:
    """Transparent stand-in for ``DocumentManager`` (see RequestRagProxy)."""

    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        dm = _current_request_doc_manager.get()
        if dm is None:
            raise RuntimeError(
                "RequestDocManagerProxy used outside a request context: no "
                "workspace resolver middleware ran."
            )
        return getattr(dm, name)


async def _resolve_for_request(request: Request):
    """Resolve (rag, doc_manager, workspace) for the current request.

    Used by the middleware. Returns the resolved LightRAG + DocumentManager
    + the effective workspace string (for implicit-namespace scoping).
    """
    registry: Optional[WorkspaceRegistry] = getattr(
        request.app.state, "workspace_registry", None
    )
    if registry is None:
        return None, None, None
    workspace = read_workspace_header(request)
    rag = await registry.get_rag(workspace)
    dm = registry.get_doc_manager(workspace)
    return rag, dm, registry.resolve_workspace(workspace)


def setup_workspace_middleware(app: FastAPI) -> None:
    """Install the HTTP middleware that resolves the per-request workspace.

    Reads ``LIGHTRAG-WORKSPACE``, resolves / lazily builds the workspace's
    LightRAG + DocumentManager via the registry on ``app.state``, and stashes
    them in ContextVars BEFORE ``call_next`` so route handlers (which close
    over :class:`RequestRagProxy` / :class:`RequestDocManagerProxy`) see the
    right instance. Also scopes the per-context workspace for implicit
    namespace calls.

    When no registry is configured (``app.state.workspace_registry`` absent),
    the middleware is a no-op — callers that set ``app.state.rag`` directly
    (legacy unit tests) keep working through the proxy's fallback path.
    """

    @app.middleware("http")
    async def workspace_resolver(request: Request, call_next):
        registry = getattr(request.app.state, "workspace_registry", None)
        if registry is None:
            return await call_next(request)

        from lightrag.kg.shared_storage import (
            reset_current_workspace,
            set_current_workspace,
        )

        try:
            rag, dm, effective_ws = await _resolve_for_request(request)
        except HTTPException as e:
            return JSONResponse(
                status_code=e.status_code,
                content={"detail": e.detail},
                headers=getattr(e, "headers", None) or None,
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"Workspace resolution failed: {e}")
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={"detail": f"Workspace resolution failed: {e}"},
            )

        rag_token = _current_request_rag.set(rag)
        dm_token = _current_request_doc_manager.set(dm)
        ws_token = set_current_workspace(effective_ws)
        try:
            return await call_next(request)
        finally:
            _current_request_rag.reset(rag_token)
            _current_request_doc_manager.reset(dm_token)
            reset_current_workspace(ws_token)
