"""Offline tests for the multi-workspace registry + request proxy + middleware.

These cover the plumbing that lets one API process serve multiple workspaces
via the ``LIGHTRAG-WORKSPACE`` header, without needing a real LLM/embedding
backend (a fake rag with async no-op init is enough).
"""

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lightrag.api.workspace_registry import (
    RequestRagProxy,
    WorkspaceNotAllowed,
    WorkspaceRegistry,
    setup_workspace_middleware,
)
from lightrag.kg.shared_storage import (
    get_default_workspace,
    set_current_workspace,
)

pytestmark = pytest.mark.offline


class _FakeRag:
    """Minimal async rag stub keyed by workspace."""

    def __init__(self, workspace: str):
        self.workspace = workspace

    async def initialize_storages(self):
        return None

    async def check_and_migrate_data(self):
        return None

    async def finalize_storages(self):
        return None


def _make_registry(default_workspace="", allowlist=None, multi_workspace=False):
    built = {}

    def factory(ws):
        rag = _FakeRag(ws)
        built[ws] = rag
        return rag

    reg = WorkspaceRegistry(
        rag_factory=factory,
        doc_manager_factory=lambda ws: object(),
        default_workspace=default_workspace,
        allowlist=allowlist,
        multi_workspace=multi_workspace,
    )
    return reg, built


def test_registry_caches_per_workspace_and_lazily_inits():
    reg, built = _make_registry(
        default_workspace="default", multi_workspace=True, allowlist={"a", "b"}
    )
    # Default is not pre-registered -> get_rag builds + inits it.
    rag_default = asyncio.run(reg.get_rag("default"))
    assert rag_default.workspace == "default"
    assert "default" in built

    # Same workspace returns the cached instance (no rebuild).
    assert asyncio.run(reg.get_rag("default")) is rag_default
    assert len(built) == 1

    # A different workspace gets a distinct cached instance.
    rag_a = asyncio.run(reg.get_rag("a"))
    assert rag_a is not rag_default
    assert rag_a.workspace == "a"
    assert asyncio.run(reg.get_rag("a")) is rag_a


def test_register_default_skips_rebuild_and_initialize_default_inits_cached():
    reg, built = _make_registry(default_workspace="default")
    pre = _FakeRag("default")
    reg.register_default(pre)
    # initialize_default inits the pre-registered rag without rebuilding.
    asyncio.run(reg.initialize_default())
    assert built == {}  # factory never invoked
    assert reg.get_rag_if_cached("default") is pre


def test_resolve_workspace_allowlist_enforced():
    reg, _ = _make_registry(
        default_workspace="default", multi_workspace=True, allowlist={"a"}
    )
    assert reg.resolve_workspace(None) == "default"  # header absent -> default
    assert reg.resolve_workspace("a") == "a"
    assert reg.resolve_workspace("") == "default"
    with pytest.raises(WorkspaceNotAllowed):
        reg.resolve_workspace("b")  # not in allowlist


def test_resolve_workspace_single_mode_rejects_non_default():
    reg, _ = _make_registry(default_workspace="default", multi_workspace=False)
    assert reg.resolve_workspace(None) == "default"
    assert reg.resolve_workspace("") == "default"
    with pytest.raises(WorkspaceNotAllowed):
        reg.resolve_workspace("other")


def test_proxy_delegates_to_contextvar():
    proxy = RequestRagProxy()
    # Outside a request context the proxy raises (no middleware set the var).
    with pytest.raises(RuntimeError):
        proxy.workspace

    token = set_current_workspace("ignored-for-proxy")  # set_current_workspace
    # set_current_workspace scopes implicit namespace resolution, not the proxy;
    # the proxy reads _current_request_rag which is still unset.
    try:
        with pytest.raises(RuntimeError):
            proxy.workspace
    finally:
        from lightrag.kg.shared_storage import reset_current_workspace

        reset_current_workspace(token)


def _build_app(default_workspace, allowlist=None, multi_workspace=True):
    """Build a FastAPI app whose /whoami route closes over a RequestRagProxy
    and returns the resolved rag's workspace."""
    reg, _ = _make_registry(
        default_workspace=default_workspace,
        allowlist=allowlist,
        multi_workspace=multi_workspace,
    )
    app = FastAPI()
    app.state.workspace_registry = reg
    setup_workspace_middleware(app)

    proxy = RequestRagProxy()

    @app.get("/whoami")
    async def whoami():
        # The proxy forwards .workspace to the per-request rag set by the
        # middleware. No header -> default workspace's rag.
        return {"workspace": proxy.workspace}

    return app, reg


def test_middleware_routes_to_requested_workspace():
    app, reg = _build_app(default_workspace="default", allowlist={"a", "b"})
    client = TestClient(app)

    # No header -> default workspace.
    r = client.get("/whoami")
    assert r.status_code == 200, r.text
    assert r.json()["workspace"] == "default"

    # Header selects a different workspace (lazily built + cached).
    r = client.get("/whoami", headers={"LIGHTRAG-WORKSPACE": "a"})
    assert r.status_code == 200, r.text
    assert r.json()["workspace"] == "a"

    # b is distinct from a.
    r = client.get("/whoami", headers={"LIGHTRAG-WORKSPACE": "b"})
    assert r.status_code == 200, r.text
    assert r.json()["workspace"] == "b"

    # a is cached (same instance as before).
    assert reg.get_rag_if_cached("a").workspace == "a"


def test_middleware_rejects_unknown_workspace_with_404():
    app, _ = _build_app(default_workspace="default", allowlist={"a"})
    client = TestClient(app)
    r = client.get("/whoami", headers={"LIGHTRAG-WORKSPACE": "evil"})
    assert r.status_code == 404
    assert "evil" in r.json()["detail"]


def test_get_default_workspace_reads_contextvar():
    """The per-context workspace (ContextVar) takes precedence over the
    process-wide default, so multiple LightRAG instances in one process
    don't leak implicit namespace calls into the first instance's workspace."""
    assert get_default_workspace() is None  # nothing set in a fresh test
    token = set_current_workspace("ctxws")
    try:
        assert get_default_workspace() == "ctxws"
    finally:
        from lightrag.kg.shared_storage import reset_current_workspace

        reset_current_workspace(token)
    assert get_default_workspace() is None


def test_list_workspaces_unions_allowlist_and_initialized():
    reg, _ = _make_registry(
        default_workspace="default", multi_workspace=True, allowlist={"a", "b"}
    )
    # Nothing initialized yet -> only the allowlist (default + a + b).
    assert reg.list_initialized_workspaces() == []
    assert reg.list_allowed_workspaces() == ["a", "b", "default"]

    # Pre-register the default (as create_app does) -> it shows as initialized.
    reg.register_default(_FakeRag("default"))
    assert reg.list_initialized_workspaces() == ["default"]

    # Lazily build another workspace -> it shows as initialized too.
    asyncio.run(reg.get_rag("a"))
    assert reg.list_initialized_workspaces() == ["a", "default"]

