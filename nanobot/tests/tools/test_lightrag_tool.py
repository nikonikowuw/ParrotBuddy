"""Tests for the LightRAG vector retrieval tool."""

from types import SimpleNamespace

import httpx
import pytest

from nanobot.agent.tools.context import RequestContext, request_context
from nanobot.agent.tools.lightrag import LightRagQueryTool, LightRagToolConfig
from nanobot.agent.tools.registry import is_tool_error_result
from nanobot.config.schema import ToolsConfig


def _tool(
    *,
    api_base: str = "http://127.0.0.1:9621",
    api_key: str | None = None,
    workspaces: list[str] | None = None,
    default_workspace: str | None = None,
    include_references: bool = True,
    include_chunk_content: bool = False,
    default_top_k: int | None = None,
    default_query_mode: str = "mix",
) -> LightRagQueryTool:
    return LightRagQueryTool(
        config=LightRagToolConfig(
            enabled=True,
            api_base=api_base,
            api_key=api_key,
            workspaces=workspaces or [],
            default_workspace=default_workspace,
            include_references=include_references,
            include_chunk_content=include_chunk_content,
            default_top_k=default_top_k,
            default_query_mode=default_query_mode,  # type: ignore[arg-type]
        )
    )


def _response(status: int = 200, json: dict | None = None) -> httpx.Response:
    """Build a mock httpx.Response with a dummy request attached."""
    r = httpx.Response(status, json=json)
    r._request = httpx.Request("POST", "https://mock")
    return r


def _webui_ctx(
    workspaces: list[str] | None,
    *,
    original_user_text: str | None = "how do I configure X?",
) -> "RequestContext":
    """A WebUI turn context carrying a UI-selected knowledge-base list.

    Pass ``None`` to simulate "WebUI cleared selection" (webui flag set, no KB).
    """
    metadata: dict = {"webui": True}
    if workspaces is not None:
        metadata["lightrag_workspaces"] = workspaces
    return RequestContext(
        channel="test",
        chat_id="t",
        metadata=metadata,
        original_user_text=original_user_text,
    )


def _bind(ctx: RequestContext):
    return request_context(ctx)


# --- tool metadata ----------------------------------------------------------


def test_read_only_and_concurrency_safe():
    tool = _tool()
    assert tool.read_only is True
    assert tool.concurrency_safe is True


def test_enabled_gate_reads_config():
    assert LightRagQueryTool.enabled(SimpleNamespace(config=ToolsConfig())) is False
    ctx = SimpleNamespace(
        config=ToolsConfig(lightrag=LightRagToolConfig(enabled=True))
    )
    assert LightRagQueryTool.enabled(ctx) is True


def test_create_builds_from_ctx():
    ctx = SimpleNamespace(
        config=ToolsConfig(lightrag=LightRagToolConfig(enabled=True, api_base="http://x:1"))
    )
    tool = LightRagQueryTool.create(ctx)
    assert isinstance(tool, LightRagQueryTool)
    assert tool.config.api_base == "http://x:1"


def test_to_schema_has_no_workspace_param():
    schema = _tool().to_schema()
    fn = schema["function"]
    assert fn["name"] == "lightrag_query"
    props = fn["parameters"]["properties"]
    assert set(props) == {"query", "mode", "top_k", "only_need_context", "include_references"}
    assert "workspace" not in props  # LLM cannot pick a workspace
    assert fn["parameters"]["required"] == ["query"]
    assert set(props["mode"]["enum"]) == {"local", "global", "hybrid", "naive", "mix", "bypass"}


def test_runtime_context_provider_is_bound():
    tool = _tool()
    assert callable(tool.runtime_context_provider())


# --- CLI path (no RequestContext): config.default_workspace drives scope -----


@pytest.mark.asyncio
async def test_cli_default_workspace_sets_header(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["url"] = url
        captured["headers"] = kw["headers"]
        captured["json"] = kw["json"]
        return _response(json={
            "response": "RAG combines retrieval with generation.",
            "references": [{"reference_id": "1", "file_path": "/docs/rag.pdf"}],
        })

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(api_key="lk", workspaces=["proj1"], default_workspace="proj1")
    result = await tool.execute(query="What is RAG?")

    assert captured["url"] == "http://127.0.0.1:9621/query"
    assert captured["headers"]["X-API-Key"] == "lk"
    assert captured["headers"]["LIGHTRAG-WORKSPACE"] == "proj1"
    assert captured["json"] == {
        "query": "What is RAG?",
        "mode": "mix",
        "include_references": True,
    }
    assert "RAG combines retrieval with generation." in result
    assert "## Workspace: proj1" in result
    assert "/docs/rag.pdf (id:1)" in result


@pytest.mark.asyncio
async def test_cli_no_default_skips_recall(monkeypatch):
    async def mock_post(self, url, **kw):
        raise AssertionError("must not call LightRAG when no scope is configured")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool()  # no default_workspace, no context
    result = await tool.execute(query="q?")

    assert "No knowledge base selected" in result
    assert "recall skipped" in result
    assert not is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_cli_mode_override_and_top_k(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={"response": "ctx", "references": None})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(default_top_k=20, default_workspace="proj")
    result = await tool.execute(query="entities", mode="local", top_k=5)

    assert captured["json"]["mode"] == "local"
    assert captured["json"]["top_k"] == 5  # explicit param wins over config default
    assert "ctx" in result


@pytest.mark.asyncio
async def test_cli_only_need_context(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={"response": "raw chunk context"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(default_workspace="proj")
    result = await tool.execute(query="recall", only_need_context=True)

    assert captured["json"]["only_need_context"] is True
    assert "raw chunk context" in result


@pytest.mark.asyncio
async def test_cli_include_references_false(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={
            "response": "ans",
            "references": [{"reference_id": "1", "file_path": "/x.pdf"}],
        })

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(default_workspace="proj")
    result = await tool.execute(query="q?", include_references=False)

    assert captured["json"]["include_references"] is False
    assert "/x.pdf" not in result  # refs omitted when include_references=False


@pytest.mark.asyncio
async def test_cli_include_chunk_content(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={
            "response": "ans",
            "references": [{"reference_id": "7", "file_path": "/c.md", "content": ["line A", "line B"]}],
        })

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(default_workspace="proj", include_chunk_content=True)
    result = await tool.execute(query="q?")

    assert captured["json"]["include_chunk_content"] is True
    assert "## Workspace: proj" in result
    assert "/c.md (id:7)" in result
    assert "line A" in result
    assert "line B" in result


@pytest.mark.asyncio
async def test_cli_http_error_returns_tool_error(monkeypatch):
    async def mock_post(self, url, **kw):
        return _response(status=401, json={"detail": "bad key"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(api_key="bad", default_workspace="proj")
    result = await tool.execute(query="q?")

    assert "Error: LightRAG query failed (401)" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_cli_request_error_returns_tool_error(monkeypatch):
    async def mock_post(self, url, **kw):
        raise httpx.ConnectError("conn refused", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(default_workspace="proj")
    result = await tool.execute(query="q?")

    assert "Error: LightRAG request failed" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_cli_non_json_response_returns_error(monkeypatch):
    r = httpx.Response(200, content=b"not json")
    r._request = httpx.Request("POST", "https://mock")

    async def mock_post(self, url, **kw):
        return r

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(default_workspace="proj")
    result = await tool.execute(query="q?")

    assert "non-JSON" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_invalid_mode_rejected(monkeypatch):
    async def mock_post(self, url, **kw):
        return _response(json={"response": "x"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(default_workspace="proj")
    result = await tool.execute(query="q?", mode="bogus")

    assert "mode must be one of" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_invalid_api_base_returns_error_before_scope():
    tool = _tool(api_base="ftp://nope")
    result = await tool.execute(query="q?")

    assert "LightRAG api_base invalid" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_env_api_key_fallback(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["headers"] = kw["headers"]
        return _response(json={"response": "ok"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    monkeypatch.setenv("LIGHTRAG_API_KEY", "env-key")
    tool = _tool(default_workspace="proj")  # CLI scope
    await tool.execute(query="q?")

    assert captured["headers"]["X-API-Key"] == "env-key"


# --- WebUI path: RequestContext.metadata drives scope ------------------------


@pytest.mark.asyncio
async def test_webui_single_workspace_sets_header(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["headers"] = kw["headers"]
        captured["json"] = kw["json"]
        return _response(json={"response": "ans"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b"])
    with _bind(_webui_ctx(["a"])):
        result = await tool.execute(query="q?")

    assert captured["headers"]["LIGHTRAG-WORKSPACE"] == "a"
    # single-workspace path does NOT force only_need_context
    assert "only_need_context" not in captured["json"]
    assert "## Workspace: a" in result
    assert "ans" in result


@pytest.mark.asyncio
async def test_webui_default_sentinel_uses_server_default(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["headers"] = kw["headers"]
        return _response(json={"response": "server-ans"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b"])
    with _bind(_webui_ctx(["__default__"])):
        result = await tool.execute(query="q?")

    # __default__ sentinel → no LIGHTRAG-WORKSPACE header (server default)
    assert "LIGHTRAG-WORKSPACE" not in captured["headers"]
    assert "## Workspace: (default)" in result
    assert "server-ans" in result


@pytest.mark.asyncio
async def test_webui_empty_selection_skips(monkeypatch):
    async def mock_post(self, url, **kw):
        raise AssertionError("must not call LightRAG when WebUI selection is empty")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b"])
    with _bind(_webui_ctx([])):
        result = await tool.execute(query="q?")

    assert "No knowledge base selected" in result
    assert not is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_webui_no_kb_key_skips(monkeypatch):
    """WebUI turn with the webui flag but no lightrag_workspaces key at all."""
    async def mock_post(self, url, **kw):
        raise AssertionError("must not call LightRAG without a selection")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b"], default_workspace="proj")
    with _bind(_webui_ctx(None)):
        result = await tool.execute(query="q?")

    # WebUI empty → skip, even though config.default_workspace is set
    assert "No knowledge base selected" in result


@pytest.mark.asyncio
async def test_webui_fanout_multi_workspace(monkeypatch):
    calls: list[dict] = []

    async def mock_post(self, url, **kw):
        ws = kw["headers"].get("LIGHTRAG-WORKSPACE")
        calls.append({"ws": ws, "json": kw["json"]})
        return _response(json={"response": f"ctx-{ws}"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b"])
    with _bind(_webui_ctx(["a", "b"])):
        result = await tool.execute(query="q?")

    assert len(calls) == 2
    assert {c["ws"] for c in calls} == {"a", "b"}
    for c in calls:
        # fan-out forces raw-context recall regardless of LLM flag
        assert c["json"]["only_need_context"] is True
    assert "## Workspace: a" in result
    assert "## Workspace: b" in result
    assert "ctx-a" in result
    assert "ctx-b" in result


@pytest.mark.asyncio
async def test_webui_fanout_forces_only_need_context_even_when_llm_says_false(monkeypatch):
    captured: list[dict] = []

    async def mock_post(self, url, **kw):
        captured.append(kw["json"])
        return _response(json={"response": "ctx"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b"])
    with _bind(_webui_ctx(["a", "b"])):
        await tool.execute(query="q?", only_need_context=False)

    assert len(captured) == 2
    for body in captured:
        assert body["only_need_context"] is True


@pytest.mark.asyncio
async def test_webui_fanout_partial_failure_is_graceful(monkeypatch):
    async def mock_post(self, url, **kw):
        ws = kw["headers"].get("LIGHTRAG-WORKSPACE")
        if ws == "bad":
            return _response(status=500, json={"detail": "boom"})
        return _response(json={"response": "ok-good"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["bad", "good"])
    with _bind(_webui_ctx(["bad", "good"])):
        result = await tool.execute(query="q?")

    assert "## Workspace: bad" in result
    assert "(error:" in result
    assert "## Workspace: good" in result
    assert "ok-good" in result
    # multi-workspace failures degrade gracefully, NOT a hard tool error
    assert not is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_webui_workspace_validated_against_allowlist():
    tool = _tool(workspaces=["a", "b"])  # allowlist only a, b
    with _bind(_webui_ctx(["x"])):
        result = await tool.execute(query="q?")

    assert "not in configured allowlist" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_webui_default_sentinel_ignores_mixed_named(monkeypatch):
    """If the (exclusive) Default sentinel appears alongside names, Default wins."""
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["headers"] = kw["headers"]
        return _response(json={"response": "ok"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b"])
    with _bind(_webui_ctx(["__default__", "a"])):
        result = await tool.execute(query="q?")

    assert "LIGHTRAG-WORKSPACE" not in captured["headers"]
    assert "## Workspace: (default)" in result


@pytest.mark.asyncio
async def test_non_webui_context_falls_through_to_cli_default(monkeypatch):
    """A context without the webui flag is treated as CLI (config default)."""
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["headers"] = kw["headers"]
        return _response(json={"response": "ok"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(workspaces=["a", "b", "proj"], default_workspace="proj")
    # metadata has lightrag_workspaces=["a"] but NO webui flag → CLI path
    ctx = RequestContext(
        channel="test",
        chat_id="t",
        metadata={"lightrag_workspaces": ["a"]},
    )
    with _bind(ctx):
        result = await tool.execute(query="q?")

    # CLI path uses config.default_workspace, ignoring the metadata list
    assert captured["headers"]["LIGHTRAG-WORKSPACE"] == "proj"
    assert "## Workspace: proj" in result


# --- runtime_context_provider ------------------------------------------------


@pytest.mark.asyncio
async def test_runtime_context_block_cli_active_is_directive():
    tool = _tool(default_workspace="proj")
    block = await tool._provide_runtime_context(
        RequestContext(
            channel="test",
            chat_id="t",
            metadata={},
            original_user_text="how do I configure X?",
        )
    )
    assert block is not None
    assert block.source == "lightrag"
    assert "active" in block.content
    assert "proj" in block.content
    # directive phrasing: steer the LLM to call the tool first
    assert "lightrag_query" in block.content
    assert "do not wait" in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_webui_selection_is_directive():
    tool = _tool(workspaces=["a", "b"])
    block = await tool._provide_runtime_context(_webui_ctx(["a", "b"]))
    assert block is not None
    assert "active" in block.content
    assert "a" in block.content and "b" in block.content
    assert "lightrag_query" in block.content
    assert "do not wait" in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_webui_default_sentinel():
    tool = _tool(workspaces=["a", "b"])
    block = await tool._provide_runtime_context(_webui_ctx(["__default__"]))
    assert block is not None
    assert "server default" in block.content
    assert "lightrag_query" in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_webui_empty_is_disabled():
    tool = _tool(workspaces=["a", "b"], default_workspace="proj")
    block = await tool._provide_runtime_context(_webui_ctx(None))
    assert block is not None
    assert "disabled" in block.content
    assert "no knowledge base selected" in block.content
    assert "Do not call lightrag_query" in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_continuation_turn_returns_none():
    """Internal continuation turns (no original_user_text) stay silent."""
    tool = _tool(default_workspace="proj")
    block = await tool._provide_runtime_context(
        RequestContext(
            channel="test",
            chat_id="t",
            metadata={},
            original_user_text=None,
        )
    )
    assert block is None
