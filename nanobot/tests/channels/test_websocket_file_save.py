"""Tests for the WebUI file-save round trip.

Covers ``write_file_bytes`` (workspace-boundary + atomic write semantics in
``nanobot/webui/file_preview.py``) and the ``save_file`` WebSocket envelope
handler (``WebSocketChannel._save_file_event``) that the WebUI editor uses
to persist edited documents back to their original paths.
"""

from __future__ import annotations

import base64
import json
import os
import stat
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.channels.websocket import WebSocketChannel
from nanobot.security.workspace_access import (
    WorkspaceSandboxStatus,
    WorkspaceScope,
)
from nanobot.session.manager import SessionManager
from nanobot.webui.file_preview import (
    MAX_FILE_SAVE_BYTES,
    WebUIFilePreviewError,
    write_file_bytes,
)
from nanobot.webui.gateway_services import build_gateway_services


def _scope(
    project_path: Path,
    *,
    restrict: bool,
) -> WorkspaceScope:
    return WorkspaceScope(
        project_path=project_path,
        access_mode="restricted" if restrict else "full",
        restrict_to_workspace=restrict,
        sandbox_status=WorkspaceSandboxStatus(
            restrict_to_workspace=restrict,
            workspace_root=str(project_path),
            level="restricted" if restrict else "full",
            enforced=restrict,
            provider="none",
            provider_label="None",
            summary="test scope",
        ),
        source_channel="webui",
    )


def _channel(
    bus: MagicMock,
    *,
    workspace_path: Path,
    restrict: bool = False,
    session_manager: SessionManager | None = None,
) -> WebSocketChannel:
    from nanobot.channels.websocket import WebSocketConfig

    cfg: dict[str, Any] = {
        "enabled": True,
        "allowFrom": ["*"],
        "host": "127.0.0.1",
        "port": 29877,
        "path": "/ws",
        "websocketRequiresToken": False,
    }
    parsed = WebSocketConfig.model_validate(cfg)
    gateway = build_gateway_services(
        config=parsed,
        bus=bus,
        session_manager=session_manager,
        static_dist_path=None,
        workspace_path=workspace_path,
        default_restrict_to_workspace=restrict,
        runtime_model_name=None,
        runtime_surface="browser",
        runtime_capabilities_overrides=None,
    )
    return WebSocketChannel(cfg, bus, gateway=gateway)


# -- write_file_bytes ----------------------------------------------------------


def test_write_file_bytes_overwrites_existing_file(tmp_path: Path) -> None:
    scope = _scope(tmp_path, restrict=True)
    target = tmp_path / "report.xlsx"
    target.write_bytes(b"OLD-CONTENT")

    saved = write_file_bytes(str(target), b"NEW-CONTENT", scope=scope)

    assert saved == str(target.resolve())
    assert target.read_bytes() == b"NEW-CONTENT"
    # atomic write must not leave the temp file behind
    assert not list(tmp_path.glob("*.tmp"))


def test_write_file_bytes_requires_existing_file(tmp_path: Path) -> None:
    scope = _scope(tmp_path, restrict=True)
    missing = tmp_path / "missing.xlsx"

    with pytest.raises(WebUIFilePreviewError) as exc:
        write_file_bytes(str(missing), b"data", scope=scope)
    assert exc.value.status == 404
    assert not missing.exists()


def test_write_file_bytes_rejects_outside_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.xlsx"
    outside.write_bytes(b"SECRET")
    scope = _scope(workspace, restrict=True)

    with pytest.raises(WebUIFilePreviewError) as exc:
        write_file_bytes(str(outside), b"data", scope=scope)
    assert exc.value.status == 403
    # the outside file must remain untouched
    assert outside.read_bytes() == b"SECRET"


def test_write_file_bytes_rejects_oversized(tmp_path: Path) -> None:
    scope = _scope(tmp_path, restrict=True)
    target = tmp_path / "big.xlsx"
    target.write_bytes(b"x")

    with pytest.raises(WebUIFilePreviewError) as exc:
        write_file_bytes(str(target), b"y" * 1024, scope=scope, max_bytes=128)
    assert exc.value.status == 413
    assert target.read_bytes() == b"x"


def test_write_file_bytes_rejects_path_traversal(tmp_path: Path) -> None:
    scope = _scope(tmp_path, restrict=True)
    target = tmp_path / "ok.xlsx"
    target.write_bytes(b"x")

    with pytest.raises(WebUIFilePreviewError):
        write_file_bytes(str(tmp_path / ".." / "escape.xlsx"), b"y", scope=scope)


def test_write_file_bytes_preserves_file_mode(tmp_path: Path) -> None:
    scope = _scope(tmp_path, restrict=True)
    target = tmp_path / "secret.xlsx"
    target.write_bytes(b"OLD")
    os.chmod(target, 0o600)

    write_file_bytes(str(target), b"NEW", scope=scope)

    assert target.read_bytes() == b"NEW"
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert not list(tmp_path.glob("*.tmp"))


# -- save_file envelope --------------------------------------------------------


@pytest.mark.asyncio
async def test_save_file_envelope_writes_existing_file(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "report.xlsx"
    target.write_bytes(b"OLD")
    bus = MagicMock()
    channel = _channel(
        bus,
        workspace_path=workspace,
        restrict=True,
        session_manager=SessionManager(tmp_path / "sessions"),
    )
    conn = AsyncMock()
    conn.remote_address = ("127.0.0.1", 50123)
    content = b"PK\x03\x04new-xlsx-content"

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "save_file",
            "chat_id": "chat-1",
            "request_id": "req-1",
            "path": str(target),
            "content_b64": base64.b64encode(content).decode(),
        },
    )

    conn.send.assert_awaited_once()
    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_saved"
    assert payload["request_id"] == "req-1"
    assert payload["path"] == str(target.resolve())
    assert target.read_bytes() == content


@pytest.mark.asyncio
async def test_save_file_envelope_rejects_missing_request_id(tmp_path: Path) -> None:
    bus = MagicMock()
    channel = _channel(bus, workspace_path=tmp_path)
    conn = AsyncMock()

    await channel._dispatch_envelope(
        conn, "webui-client", {"type": "save_file", "chat_id": "chat-1"}
    )

    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_save_error"
    assert payload["detail"] == "missing_request_id"


@pytest.mark.asyncio
async def test_save_file_envelope_rejects_invalid_chat_id(tmp_path: Path) -> None:
    bus = MagicMock()
    channel = _channel(bus, workspace_path=tmp_path)
    conn = AsyncMock()

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {"type": "save_file", "chat_id": "../evil", "request_id": "r1"},
    )

    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_save_error"
    assert payload["detail"] == "invalid_chat_id"


@pytest.mark.asyncio
async def test_save_file_envelope_rejects_bad_base64(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "report.xlsx"
    target.write_bytes(b"OLD")
    bus = MagicMock()
    channel = _channel(
        bus,
        workspace_path=workspace,
        restrict=True,
        session_manager=SessionManager(tmp_path / "sessions"),
    )
    conn = AsyncMock()

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "save_file",
            "chat_id": "chat-1",
            "request_id": "r1",
            "path": str(target),
            "content_b64": "!!!not-base64!!!",
        },
    )

    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_save_error"
    assert payload["detail"] == "decode"
    assert target.read_bytes() == b"OLD"


@pytest.mark.asyncio
async def test_save_file_envelope_rejects_outside_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.xlsx"
    outside.write_bytes(b"SECRET")
    bus = MagicMock()
    channel = _channel(
        bus,
        workspace_path=workspace,
        restrict=True,
        session_manager=SessionManager(tmp_path / "sessions"),
    )
    conn = AsyncMock()

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "save_file",
            "chat_id": "chat-1",
            "request_id": "r1",
            "path": str(outside),
            "content_b64": base64.b64encode(b"hacked").decode(),
        },
    )

    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_save_error"
    assert payload["detail"] == "forbidden"
    assert outside.read_bytes() == b"SECRET"


@pytest.mark.asyncio
async def test_save_file_uses_persisted_chat_scope_not_default(tmp_path: Path) -> None:
    """Saves resolve against the chat's persisted scope, never the default.

    Regression: the handler previously looked up the scope with the raw
    ``chat_id`` instead of the ``websocket:{chat_id}`` session key, so a
    per-chat scope different from the default was silently ignored — a
    restricted chat would save against an unrestricted default (escalation)
    or against the wrong workspace (lost edits).
    """
    default_ws = tmp_path / "default-workspace"
    default_ws.mkdir()
    chat_ws = tmp_path / "chat-workspace"
    chat_ws.mkdir()
    # Inside the *default* workspace (unrestricted default) but outside the
    # chat's persisted restricted workspace — must be rejected.
    outside = tmp_path / "outside.xlsx"
    outside.write_bytes(b"SECRET")
    target = chat_ws / "report.xlsx"
    target.write_bytes(b"OLD")

    bus = MagicMock()
    # Default scope is unrestricted: any existing file would be savable if
    # the handler fell back to it.
    channel = _channel(
        bus,
        workspace_path=default_ws,
        restrict=False,
        session_manager=SessionManager(tmp_path / "sessions"),
    )
    channel._workspaces.persist_scope("chat-1", _scope(chat_ws, restrict=True))
    conn = AsyncMock()
    conn.remote_address = ("127.0.0.1", 50123)

    # A file inside the persisted (non-default) workspace saves fine.
    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "save_file",
            "chat_id": "chat-1",
            "request_id": "r1",
            "path": str(target),
            "content_b64": base64.b64encode(b"NEW").decode(),
        },
    )
    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_saved"
    assert target.read_bytes() == b"NEW"

    # A file outside the persisted scope is rejected even though the
    # default scope is unrestricted.
    conn.send.reset_mock()
    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "save_file",
            "chat_id": "chat-1",
            "request_id": "r2",
            "path": str(outside),
            "content_b64": base64.b64encode(b"hacked").decode(),
        },
    )
    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_save_error"
    assert payload["detail"] == "forbidden"
    assert outside.read_bytes() == b"SECRET"


@pytest.mark.asyncio
async def test_save_file_envelope_rejects_oversized_before_decode(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "report.xlsx"
    target.write_bytes(b"OLD")
    bus = MagicMock()
    channel = _channel(
        bus,
        workspace_path=workspace,
        restrict=True,
        session_manager=SessionManager(tmp_path / "sessions"),
    )
    conn = AsyncMock()
    # One block over the maximum valid base64 length for MAX_FILE_SAVE_BYTES
    # decoded content; the handler must reject on the length check alone
    # (never decode ~22 MB, never touch the file).
    oversized = "A" * (((MAX_FILE_SAVE_BYTES + 2) // 3) * 4 + 4)

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "save_file",
            "chat_id": "chat-1",
            "request_id": "r1",
            "path": str(target),
            "content_b64": oversized,
        },
    )

    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_save_error"
    assert payload["detail"] == "size"
    assert target.read_bytes() == b"OLD"


@pytest.mark.asyncio
async def test_save_file_envelope_write_failure_uses_single_token(tmp_path: Path) -> None:
    """A storage failure surfaces the single ``failed`` token (one token per
    failure class; previously ``write_failed`` and ``failed`` both existed)."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "report.xlsx"
    target.write_bytes(b"OLD")
    bus = MagicMock()
    channel = _channel(
        bus,
        workspace_path=workspace,
        restrict=True,
        session_manager=SessionManager(tmp_path / "sessions"),
    )
    conn = AsyncMock()
    with patch(
        "nanobot.channels.websocket.write_file_bytes",
        side_effect=WebUIFilePreviewError(500, "failed to write file"),
    ):
        await channel._dispatch_envelope(
            conn,
            "webui-client",
            {
                "type": "save_file",
                "chat_id": "chat-1",
                "request_id": "r1",
                "path": str(target),
                "content_b64": base64.b64encode(b"NEW").decode(),
            },
        )

    payload = json.loads(conn.send.call_args.args[0])
    assert payload["event"] == "file_save_error"
    assert payload["detail"] == "failed"
