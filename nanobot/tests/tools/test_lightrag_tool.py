"""Tests for the LightRAG vector retrieval tool."""

from types import SimpleNamespace

import httpx
import pytest

from nanobot.agent.tools.context import RequestContext, request_context
from nanobot.agent.tools.lightrag import (
    LightRagQueryTool,
    LightRagServerConfig,
    LightRagToolConfig,
)
from nanobot.agent.tools.registry import is_tool_error_result
from nanobot.config.schema import ToolsConfig


def _server(name: str = "proj1", **overrides: object) -> LightRagServerConfig:
    return LightRagServerConfig(name=name, **overrides)  # type: ignore[arg-type]


def _tool(
    *,
    servers: list[LightRagServerConfig] | None = None,
    default_workspace: str | None = None,
    config_loader=None,
) -> LightRagQueryTool:
    return LightRagQueryTool(
        config=LightRagToolConfig(
            enabled=True,
            servers=servers or [],
            default_workspace=default_workspace,
        ),
        config_loader=config_loader,
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


def test_create_binds_live_config():
    cfg = LightRagToolConfig(enabled=True, servers=[_server()])
    ctx = SimpleNamespace(config=ToolsConfig(lightrag=cfg))
    tool = LightRagQueryTool.create(ctx)
    assert isinstance(tool, LightRagQueryTool)
    assert tool._get_live_config() is cfg


def test_live_config_reloads_from_loader():
    cfg = LightRagToolConfig(enabled=True, servers=[_server()])
    tool = _tool(config_loader=lambda: cfg)
    assert tool._get_live_config() is cfg


def test_to_schema_has_no_workspace_param():
    schema = _tool().to_schema()
    fn = schema["function"]
    assert fn["name"] == "lightrag_query"
    props = fn["parameters"]["properties"]
    assert set(props) == {"query", "mode", "top_k", "only_need_context", "include_references"}
    assert "workspace" not in props  # LLM cannot pick a knowledge base
    assert fn["parameters"]["required"] == ["query"]
    assert set(props["mode"]["enum"]) == {"local", "global", "hybrid", "naive", "mix", "bypass"}


def test_runtime_context_provider_is_bound():
    tool = _tool()
    assert callable(tool.runtime_context_provider())


# --- CLI path (no RequestContext): config.default_workspace drives scope -----


@pytest.mark.asyncio
async def test_cli_default_workspace_queries_server(monkeypatch):
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
    tool = _tool(
        servers=[_server(name="proj1", api_key="lk")],
        default_workspace="proj1",
    )
    result = await tool.execute(query="What is RAG?")

    assert captured["url"] == "http://127.0.0.1:9621/query"
    assert captured["headers"]["X-API-Key"] == "lk"
    assert "LIGHTRAG-WORKSPACE" not in captured["headers"]
    assert captured["json"] == {
        "query": "What is RAG?",
        "mode": "mix",
        "include_references": True,
    }
    assert "RAG combines retrieval with generation." in result
    assert "## Knowledge Base: proj1" in result
    assert "[/docs/rag.pdf](/api/lightrag/file/proj1/docs/rag.pdf) (id:1)" in result


@pytest.mark.asyncio
async def test_cli_no_default_skips_recall(monkeypatch):
    async def mock_post(self, url, **kw):
        raise AssertionError("must not call LightRAG when no scope is configured")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool()
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
    tool = _tool(
        servers=[_server(name="proj", default_top_k=20)],
        default_workspace="proj",
    )
    result = await tool.execute(query="entities", mode="local", top_k=5)

    assert captured["json"]["mode"] == "local"
    assert captured["json"]["top_k"] == 5
    assert "ctx" in result


@pytest.mark.asyncio
async def test_cli_only_need_context(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={"response": "raw chunk context"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
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
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
    result = await tool.execute(query="q?", include_references=False)

    assert captured["json"]["include_references"] is False
    assert "/x.pdf" not in result


@pytest.mark.asyncio
async def test_cli_include_chunk_content(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={
            "response": "ans",
            "references": [{
                "reference_id": "7",
                "file_path": "/c.md",
                "content": ["line A", "line B"],
            }],
        })

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(
        servers=[_server("proj", include_chunk_content=True)],
        default_workspace="proj",
    )
    result = await tool.execute(query="q?")

    assert captured["json"]["include_chunk_content"] is True
    assert "## Knowledge Base: proj" in result
    assert "[/c.md](/api/lightrag/file/proj/c.md) (id:7)" in result
    assert "line A" in result
    assert "line B" in result


@pytest.mark.asyncio
async def test_cli_http_error_returns_tool_error(monkeypatch):
    async def mock_post(self, url, **kw):
        return _response(status=401, json={"detail": "bad key"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(
        servers=[_server("proj", api_key="bad")],
        default_workspace="proj",
    )
    result = await tool.execute(query="q?")

    assert "query failed with 401" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_cli_request_error_returns_tool_error(monkeypatch):
    async def mock_post(self, url, **kw):
        raise httpx.ConnectError("conn refused", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
    result = await tool.execute(query="q?")

    assert "request failed" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_cli_non_json_response_returns_error(monkeypatch):
    r = httpx.Response(200, content=b"not json")
    r._request = httpx.Request("POST", "https://mock")

    async def mock_post(self, url, **kw):
        return r

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
    result = await tool.execute(query="q?")

    assert "non-JSON" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_invalid_mode_rejected(monkeypatch):
    async def mock_post(self, url, **kw):
        return _response(json={"response": "x"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
    result = await tool.execute(query="q?", mode="bogus")

    assert "mode must be one of" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_invalid_api_base_returns_error():
    tool = _tool(
        servers=[_server(name="bad", api_base="ftp://nope")],
        default_workspace="bad",
    )
    result = await tool.execute(query="q?")

    assert "invalid api_base" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_env_api_key_fallback(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["headers"] = kw["headers"]
        return _response(json={"response": "ok"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    monkeypatch.setenv("LIGHTRAG_API_KEY", "env-key")
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
    await tool.execute(query="q?")

    assert captured["headers"]["X-API-Key"] == "env-key"


# --- WebUI path: RequestContext.metadata drives scope ------------------------


@pytest.mark.asyncio
async def test_webui_single_server_selected(monkeypatch):
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["headers"] = kw["headers"]
        captured["json"] = kw["json"]
        return _response(json={"response": "ans"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("a"), _server("b")])
    with _bind(_webui_ctx(["a"])):
        result = await tool.execute(query="q?")

    assert "LIGHTRAG-WORKSPACE" not in captured["headers"]
    assert "only_need_context" not in captured["json"]
    assert "## Knowledge Base: a" in result
    assert "ans" in result


@pytest.mark.asyncio
async def test_webui_empty_selection_skips(monkeypatch):
    async def mock_post(self, url, **kw):
        raise AssertionError("must not call LightRAG when WebUI selection is empty")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("a"), _server("b")])
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
    tool = _tool(
        servers=[_server("a"), _server("b")],
        default_workspace="proj",
    )
    with _bind(_webui_ctx(None)):
        result = await tool.execute(query="q?")

    assert "No knowledge base selected" in result


@pytest.mark.asyncio
async def test_webui_fanout_multi_server(monkeypatch):
    calls: list[dict] = []

    async def mock_post(self, url, **kw):
        calls.append({"json": kw["json"]})
        return _response(json={"response": f"ctx-{len(calls)}"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("a"), _server("b")])
    with _bind(_webui_ctx(["a", "b"])):
        result = await tool.execute(query="q?")

    assert len(calls) == 2
    for call in calls:
        assert call["json"]["only_need_context"] is True
    assert "## Knowledge Base: a" in result
    assert "## Knowledge Base: b" in result
    assert "ctx-1" in result
    assert "ctx-2" in result


@pytest.mark.asyncio
async def test_webui_fanout_forces_only_need_context_even_when_llm_says_false(monkeypatch):
    captured: list[dict] = []

    async def mock_post(self, url, **kw):
        captured.append(kw["json"])
        return _response(json={"response": "ctx"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("a"), _server("b")])
    with _bind(_webui_ctx(["a", "b"])):
        await tool.execute(query="q?", only_need_context=False)

    assert len(captured) == 2
    for body in captured:
        assert body["only_need_context"] is True


@pytest.mark.asyncio
async def test_webui_fanout_partial_failure_is_graceful(monkeypatch):
    async def mock_post(self, url, **kw):
        return _response(json={"response": "ok-good"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(
        servers=[
            _server(name="bad", api_base="ftp://nope"),
            _server("good"),
        ]
    )
    with _bind(_webui_ctx(["bad", "good"])):
        result = await tool.execute(query="q?")

    assert "## Knowledge Base: bad" in result
    assert "(error:" in result
    assert "## Knowledge Base: good" in result
    assert not is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_webui_all_failures_return_tool_error(monkeypatch):
    async def mock_post(self, url, **kw):
        return _response(status=500, json={"detail": "boom"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("bad1"), _server("bad2")])
    with _bind(_webui_ctx(["bad1", "bad2"])):
        result = await tool.execute(query="q?")

    assert "query failed with 500" in result
    assert is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_webui_unknown_selection_skips(monkeypatch):
    async def mock_post(self, url, **kw):
        raise AssertionError("must not call LightRAG for an unknown server")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("a"), _server("b")])
    with _bind(_webui_ctx(["unknown"])):
        result = await tool.execute(query="q?")

    assert "No knowledge base selected" in result
    assert not is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_webui_legacy_default_sentinel_does_not_route(monkeypatch):
    calls: list[dict] = []

    async def mock_post(self, url, **kw):
        calls.append(kw)
        return _response(json={"response": "ok"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(servers=[_server("a"), _server("b")])
    with _bind(_webui_ctx(["__default__", "a"])):
        result = await tool.execute(query="q?")

    assert len(calls) == 1
    assert "## Knowledge Base: a" in result
    assert "## Knowledge Base: b" not in result


@pytest.mark.asyncio
async def test_non_webui_context_falls_through_to_cli_default(monkeypatch):
    """A context without the webui flag is treated as CLI (config default)."""
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={"response": "ok"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    tool = _tool(
        servers=[_server("a"), _server("b"), _server("proj")],
        default_workspace="proj",
    )
    ctx = RequestContext(
        channel="test",
        chat_id="t",
        metadata={"lightrag_workspaces": ["a"]},
    )
    with _bind(ctx):
        result = await tool.execute(query="q?")

    assert "## Knowledge Base: proj" in result


# --- runtime_context_provider ------------------------------------------------


@pytest.mark.asyncio
async def test_runtime_context_block_cli_active_is_directive():
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
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
    assert "lightrag_query" in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_webui_selection_is_directive():
    tool = _tool(servers=[_server("a"), _server("b")])
    block = await tool._provide_runtime_context(_webui_ctx(["a", "b"]))
    assert block is not None
    assert "active" in block.content
    assert "a" in block.content and "b" in block.content
    assert "lightrag_query" in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_webui_empty_is_disabled():
    tool = _tool(
        servers=[_server("a"), _server("b")],
        default_workspace="proj",
    )
    block = await tool._provide_runtime_context(_webui_ctx(None))
    assert block is not None
    assert "disabled" in block.content
    assert "no knowledge base selected" in block.content
    assert "Do not call lightrag_query" in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_stale_selection_is_disabled():
    tool = _tool(servers=[_server("a")])
    block = await tool._provide_runtime_context(_webui_ctx(["unknown"]))
    assert block is not None
    assert "disabled" in block.content
    assert "unknown" not in block.content


@pytest.mark.asyncio
async def test_runtime_context_block_continuation_turn_returns_none():
    """Internal continuation turns (no original_user_text) stay silent."""
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
    block = await tool._provide_runtime_context(
        RequestContext(
            channel="test",
            chat_id="t",
            metadata={},
            original_user_text=None,
        )
    )
    assert block is None


@pytest.mark.asyncio
async def test_execute_skips_when_live_config_disabled(monkeypatch):
    """A WebUI disable takes effect on a running loop via the live config."""
    async def mock_post(self, url, **kw):
        raise AssertionError("must not call LightRAG when integration is disabled")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    disabled = LightRagToolConfig(enabled=False, servers=[_server("a")])
    tool = _tool(config_loader=lambda: disabled)
    result = await tool.execute(query="q?")

    assert "disabled" in result
    assert not is_tool_error_result("lightrag_query", result)


@pytest.mark.asyncio
async def test_runtime_context_block_live_config_disabled():
    """Runtime context reports disabled when the live config has enabled=False."""
    disabled = LightRagToolConfig(enabled=False, servers=[_server("a")])
    tool = _tool(config_loader=lambda: disabled)
    block = await tool._provide_runtime_context(_webui_ctx(["a"]))
    assert block is not None
    assert "disabled" in block.content
    assert "Do not call lightrag_query" in block.content


@pytest.mark.asyncio
async def test_execute_uses_live_config_targets(monkeypatch):
    """Server list changes (WebUI add/remove) are picked up without a restart."""
    captured: dict = {}

    async def mock_post(self, url, **kw):
        captured["json"] = kw["json"]
        return _response(json={"response": "ans"})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    live = LightRagToolConfig(
        enabled=True,
        servers=[_server("live")],
        default_workspace="live",
    )
    tool = _tool(config_loader=lambda: live)
    result = await tool.execute(query="q?")

    assert "## Knowledge Base: live" in result
    assert "ans" in result


# --- retrieved media formatting ----------------------------------------------


def test_format_server_section_emits_parent_link_and_media_context():
    """The parent stays a numbered document link; each retrieved image gets
    an indented, unnumbered Image-context line and Markdown image line."""
    tool = _tool(servers=[_server("proj")])
    data = {
        "response": "answer",
        "references": [
            {
                "reference_id": "1",
                "file_path": "demo.pdf",
                "media": [
                    {
                        "type": "image",
                        "path": "demo.blocks.assets/image.png",
                        "format": "png",
                        "name": "系统架构图",
                        "description": "图中展示了系统模块之间的调用关系。",
                    }
                ],
            }
        ],
    }
    text = tool._format_server_section(
        "proj", data, include_refs=True, api_base="http://lightrag:9621"
    )
    # Parent document citation unchanged.
    assert "1. [demo.pdf](/api/lightrag/file/proj/demo.pdf) (id:1)" in text
    # Indexed VLM description as Image context.
    assert "Image context: 系统架构图。图中展示了系统模块之间的调用关系。" in text
    # Separate unnumbered Markdown image line with the gateway URL.
    assert "![系统架构图](/api/lightrag/file/proj/demo.blocks.assets/image.png)" in text


def test_format_server_section_multiple_media_emit_multiple_lines():
    tool = _tool(servers=[_server("proj")])
    data = {
        "response": "answer",
        "references": [
            {
                "reference_id": "1",
                "file_path": "demo.pdf",
                "media": [
                    {
                        "type": "image",
                        "path": "demo.blocks.assets/image.png",
                        "format": "png",
                        "name": "图A",
                        "description": "模块关系",
                    },
                    {
                        "type": "image",
                        "path": "demo.blocks.assets/flow.png",
                        "format": "png",
                        "name": "图B",
                        "description": "流程说明",
                    },
                ],
            }
        ],
    }
    text = tool._format_server_section(
        "proj", data, include_refs=True, api_base="http://lightrag:9621"
    )
    assert text.count("Image context:") == 2
    assert text.count("![") == 2
    assert "demo.blocks.assets/flow.png" in text


def test_format_server_section_skips_non_image_and_empty_media():
    tool = _tool(servers=[_server("proj")])
    data = {
        "response": "answer",
        "references": [
            {
                "reference_id": "1",
                "file_path": "demo.pdf",
                "media": [
                    {"type": "table", "path": "demo.blocks/t.json"},
                    {"type": "image", "path": "   "},
                    {
                        "type": "image",
                        "path": "demo.blocks.assets/img.png",
                        "name": "图",
                        "description": "描述",
                    },
                ],
            }
        ],
    }
    text = tool._format_server_section(
        "proj", data, include_refs=True, api_base="http://lightrag:9621"
    )
    assert text.count("![") == 1
    assert "Image context: 图。描述" in text
    assert "t.json" not in text


def test_format_server_section_without_media_is_unchanged():
    tool = _tool(servers=[_server("proj")])
    data = {
        "response": "answer",
        "references": [{"reference_id": "1", "file_path": "demo.pdf"}],
    }
    text = tool._format_server_section(
        "proj", data, include_refs=True, api_base="http://lightrag:9621"
    )
    assert "1. [demo.pdf](/api/lightrag/file/proj/demo.pdf) (id:1)" in text
    assert "Image context" not in text
    assert "![" not in text


def test_format_server_section_media_without_api_base_uses_text():
    """Without a gateway base the media path is surfaced as plain text
    rather than a fabricated image URL."""
    tool = _tool(servers=[_server("proj")])
    data = {
        "response": "answer",
        "references": [
            {
                "reference_id": "1",
                "file_path": "demo.pdf",
                "media": [
                    {
                        "type": "image",
                        "path": "demo.blocks.assets/image.png",
                        "name": "系统架构图",
                        "description": "图中展示了系统模块之间的调用关系。",
                    }
                ],
            }
        ],
    }
    text = tool._format_server_section("proj", data, include_refs=True, api_base="")
    assert "Image context: 系统架构图。图中展示了系统模块之间的调用关系。" in text
    assert "Image media: demo.blocks.assets/image.png" in text
    assert "![系统架构图](" not in text


@pytest.mark.asyncio
async def test_runtime_context_active_scope_distinguishes_citations_from_media():
    """The active-scope directive explains the document-vs-image distinction
    and the preservation rules for image Markdown."""
    tool = _tool(servers=[_server("proj")], default_workspace="proj")
    block = await tool._provide_runtime_context(
        RequestContext(
            channel="test",
            chat_id="t",
            metadata={},
            original_user_text="what is in the diagram?",
        )
    )
    assert block is not None
    assert "Image context:" in block.content
    assert "Numbered document links" in block.content
    assert "Do not turn a parent document link into an image" in block.content
    assert "do not add image lines to the document-reference list manually" in block.content


def test_format_server_section_escapes_untrusted_markdown():
    """VLM-provided names/descriptions/paths are untrusted text: Markdown
    specials must be escaped so a malicious server cannot inject links or
    images into the rendered context."""
    tool = _tool(servers=[_server("proj")])
    data = {
        "response": "answer",
        "references": [
            {
                "reference_id": "1",
                "file_path": "demo[1].pdf",
                "media": [
                    {
                        "type": "image",
                        "path": "img [x].png",
                        "format": "png",
                        "name": "图![x](http://evil)",
                        "description": "desc `code` *bold* [link](http://evil)",
                    }
                ],
            }
        ],
    }
    text = tool._format_server_section(
        "proj", data, include_refs=True, api_base="http://lightrag:9621"
    )
    # No raw Markdown link/image may survive unescaped in the label/text.
    assert "](http://evil)" not in text
    assert "![x]" not in text
    # The injected pieces are backslash-escaped instead.
    assert "图\\!\\[x\\]" in text
    assert "\\[link\\]" in text
    assert "\\`code\\`" in text
    assert "\\*bold\\*" in text
    # The parent label is escaped too (brackets), while the URL keeps
    # brackets percent-encoded so the gateway path is unambiguous.
    assert "1. [demo\\[1\\].pdf](" in text
    assert "demo%5B1%5D.pdf" in text


def test_format_server_section_encodes_slash_in_server_name():
    """A server name containing ``/`` must be percent-encoded (``%2F``) so
    the gateway's path-splitting treats it as part of the server key, not a
    path separator."""
    tool = _tool(servers=[_server("proj/sub")])
    data = {
        "response": "answer",
        "references": [
            {
                "reference_id": "1",
                "file_path": "demo.pdf",
                "media": [
                    {
                        "type": "image",
                        "path": "img.png",
                        "format": "png",
                        "name": "图",
                        "description": "描述",
                    }
                ],
            }
        ],
    }
    text = tool._format_server_section(
        "proj/sub", data, include_refs=True, api_base="http://lightrag:9621"
    )
    assert "/api/lightrag/file/proj%2Fsub/demo.pdf" in text
    assert "/api/lightrag/file/proj%2Fsub/img.png" in text
    assert "/api/lightrag/file/proj/sub/" not in text
