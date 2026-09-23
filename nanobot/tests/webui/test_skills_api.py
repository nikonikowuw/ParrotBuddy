"""Security and protocol tests for WebUI workspace skill mutations."""

from __future__ import annotations

import base64
import io
import json
import stat
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.channels.websocket import WebSocketChannel
from nanobot.webui.gateway_services import build_gateway_services
from nanobot.webui.skills_api import (
    MAX_SKILL_UPLOAD_BYTES,
    SkillMutationError,
    _validate_skill_tree,
    delete_workspace_skill,
    upload_workspace_skill,
)


def _skill(name: str = "demo-skill") -> bytes:
    return (
        f"---\nname: {name}\ndescription: A valid test skill.\n---\n\n# {name}\n"
    ).encode()


def _archive(*members: tuple[str, bytes | int]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in members:
            if isinstance(content, int):
                info = zipfile.ZipInfo(name)
                info.external_attr = content
                archive.writestr(info, b"link-target")
            else:
                archive.writestr(name, content)
    return output.getvalue()


def _hidden_uploads(skills_root: Path) -> list[Path]:
    return list(skills_root.glob(".skill-upload-*"))


def test_uploads_standalone_skill_and_supports_overwrite(tmp_path: Path) -> None:
    res1 = upload_workspace_skill(tmp_path, "SKILL.md", _skill())
    assert res1["name"] == "demo-skill"
    assert res1["updated"] is False
    assert (tmp_path / "skills/demo-skill/SKILL.md").read_bytes() == _skill()

    with pytest.raises(SkillMutationError) as exc:
        upload_workspace_skill(tmp_path, "SKILL.md", _skill())
    assert exc.value.token == "conflict"
    assert exc.value.name == "demo-skill"

    updated_skill = _skill("demo-skill") + b"\n# extra update"
    res2 = upload_workspace_skill(tmp_path, "SKILL.md", updated_skill, overwrite=True)
    assert res2["name"] == "demo-skill"
    assert res2["updated"] is True
    assert (tmp_path / "skills/demo-skill/SKILL.md").read_bytes() == updated_skill


def test_uploads_skill_archive_with_openclaw_layout_and_ignores(tmp_path: Path) -> None:
    package = _archive(
        ("demo-skill/", b""),
        ("demo-skill/SKILL.md", _skill()),
        ("demo-skill/README.md", b"# README"),
        ("demo-skill/LICENSE.txt", b"MIT"),
        ("demo-skill/requirements.txt", b"requests\n"),
        ("demo-skill/.DS_Store", b"junk"),
        ("demo-skill/__MACOSX/._SKILL.md", b"junk"),
        ("demo-skill/scripts/run.sh", b"#!/bin/sh\n"),
        ("demo-skill/scripts/__pycache__/run.cpython-312.pyc", b"bytecode"),
        ("demo-skill/references/guide.md", b"guide"),
        ("demo-skill/assets/icon.txt", b"asset"),
        ("demo-skill/templates/template.html", b"<h1>test</h1>"),
        ("demo-skill/schemas/schema.json", b"{}"),
    )

    result = upload_workspace_skill(tmp_path, "demo.skill", package)
    assert result["name"] == "demo-skill"
    assert (tmp_path / "skills/demo-skill/scripts/run.sh").exists()
    assert (tmp_path / "skills/demo-skill/README.md").exists()
    assert (tmp_path / "skills/demo-skill/LICENSE.txt").exists()
    assert (tmp_path / "skills/demo-skill/templates/template.html").exists()
    assert (tmp_path / "skills/demo-skill/schemas/schema.json").exists()
    assert not (tmp_path / "skills/demo-skill/.DS_Store").exists()
    assert not (tmp_path / "skills/demo-skill/__MACOSX").exists()


def test_upload_rejects_archive_traversal_symlink_and_invalid_resource(tmp_path: Path) -> None:
    cases = [
        ("traversal", _archive(("../escape/SKILL.md", _skill()))),
        (
            "symlink",
            _archive(("demo-skill/", b""), ("demo-skill/SKILL.md", _skill()), ("demo-skill/link", stat.S_IFLNK << 16)),
        ),
        (
            "resource",
            _archive(("demo-skill/", b""), ("demo-skill/SKILL.md", _skill()), ("demo-skill/private/file", b"no")),
        ),
    ]
    for _label, package in cases:
        with pytest.raises(SkillMutationError) as exc:
            upload_workspace_skill(tmp_path, "demo.skill", package)
        assert exc.value.token in {"invalid_path", "forbidden", "invalid_skill"}

    assert not (tmp_path / "escape").exists()
    assert _hidden_uploads(tmp_path / "skills") == []


def test_upload_rejects_invalid_frontmatter_and_cleans_partial_staging(tmp_path: Path) -> None:
    invalid = b"---\nname: demo-skill\ndescription: [broken\n---\n"
    with pytest.raises(SkillMutationError) as exc:
        upload_workspace_skill(tmp_path, "SKILL.md", invalid)
    assert exc.value.token == "invalid_skill"
    assert _hidden_uploads(tmp_path / "skills") == []

    with patch("nanobot.webui.skills_api.os.replace", side_effect=OSError("disk full")):
        with pytest.raises(SkillMutationError) as exc:
            upload_workspace_skill(tmp_path, "SKILL.md", _skill("atomic-skill"))
    assert exc.value.token == "failed"
    assert not (tmp_path / "skills/atomic-skill").exists()
    assert _hidden_uploads(tmp_path / "skills") == []


def test_upload_rejects_oversized_payload_and_skills_symlink(tmp_path: Path) -> None:
    with pytest.raises(SkillMutationError) as exc:
        upload_workspace_skill(tmp_path, "SKILL.md", b"x" * (MAX_SKILL_UPLOAD_BYTES + 1))
    assert exc.value.token == "size"

    outside = tmp_path / "outside"
    outside.mkdir()
    skills_link = tmp_path / "skills"
    skills_link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(SkillMutationError) as exc:
        upload_workspace_skill(tmp_path, "SKILL.md", _skill())
    assert exc.value.token == "forbidden"
    assert not (outside / "demo-skill").exists()


def test_delete_only_removes_workspace_skill_and_protects_builtin(tmp_path: Path) -> None:
    upload_workspace_skill(tmp_path, "SKILL.md", _skill())
    resource = tmp_path / "skills/demo-skill/assets/data.txt"
    resource.parent.mkdir()
    resource.write_text("data", encoding="utf-8")

    assert delete_workspace_skill(tmp_path, "demo-skill") == "demo-skill"
    assert not (tmp_path / "skills/demo-skill").exists()
    with pytest.raises(SkillMutationError) as exc:
        delete_workspace_skill(tmp_path, "demo-skill")
    assert exc.value.token == "not_found"

    # Built-in skills cannot be deleted when absent from the workspace
    with pytest.raises(SkillMutationError) as exc:
        delete_workspace_skill(tmp_path, "skill-creator")
    assert exc.value.token == "forbidden"

    # Workspace skills that shadow a built-in skill CAN be deleted, unshadowing the built-in
    builtin_shadow = tmp_path / "skills/skill-creator"
    builtin_shadow.mkdir(parents=True)
    (builtin_shadow / "SKILL.md").write_bytes(_skill("skill-creator"))
    assert delete_workspace_skill(tmp_path, "skill-creator") == "skill-creator"
    assert not builtin_shadow.exists()


def test_upload_supports_utf8_bom_and_homepage(tmp_path: Path) -> None:
    bom_skill = b"\xef\xbb\xbf---\nname: bom-skill\ndescription: UTF8 with BOM\nhomepage: https://example.com\n---\n"
    assert upload_workspace_skill(tmp_path, "SKILL.md", bom_skill)["name"] == "bom-skill"
    assert (tmp_path / "skills/bom-skill/SKILL.md").exists()


def test_validate_skill_tree_rejects_symlink_behind_ignored_name(tmp_path: Path) -> None:
    """Ignored names must not smuggle a symlink past the resource walk.

    The archive extractor filters ignored members before writing, so this
    guards the ``_validate_skill_tree`` walk itself: a symlink entry whose
    basename is ignored (``__pycache__``, ``.DS_Store``, ...) must still be
    rejected rather than skipped.
    """
    outside = tmp_path / "outside"
    outside.mkdir()

    for index, ignored_name in enumerate(("__pycache__", ".DS_Store", "node_modules")):
        root = tmp_path / f"skills/case-{index}"
        (root / "scripts").mkdir(parents=True)
        (root / "SKILL.md").write_bytes(_skill(root.name))
        (root / "scripts" / ignored_name).symlink_to(outside)

        with pytest.raises(SkillMutationError) as exc:
            _validate_skill_tree(root)
        assert exc.value.token == "forbidden"


def _channel(tmp_path: Path) -> WebSocketChannel:
    from nanobot.channels.websocket import WebSocketConfig

    config = WebSocketConfig.model_validate(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": 29878,
            "path": "/ws",
            "websocketRequiresToken": False,
        }
    )
    gateway = build_gateway_services(
        config=config,
        bus=MagicMock(),
        session_manager=None,
        static_dist_path=None,
        workspace_path=tmp_path,
        default_restrict_to_workspace=False,
        runtime_model_name=None,
        runtime_surface="browser",
        runtime_capabilities_overrides=None,
    )
    return WebSocketChannel(config, MagicMock(), gateway=gateway)


@pytest.mark.asyncio
async def test_skill_mutation_envelopes_round_trip_upload_and_delete(tmp_path: Path) -> None:
    channel = _channel(tmp_path)
    connection = AsyncMock()
    encoded = base64.b64encode(_skill()).decode()

    await channel._dispatch_envelope(
        connection,
        "webui-client",
        {
            "type": "skill_upload",
            "request_id": "upload-1",
            "filename": "SKILL.md",
            "content_b64": encoded,
        },
    )
    uploaded = json.loads(connection.send.call_args.args[0])
    assert uploaded == {
        "event": "skill_uploaded",
        "request_id": "upload-1",
        "name": "demo-skill",
        "updated": False,
        "available": True,
        "unavailable_reason": "",
        "requirements": {"bins": [], "env": [], "missing_bins": [], "missing_env": []},
    }

    connection.send.reset_mock()
    await channel._dispatch_envelope(
        connection,
        "webui-client",
        {
            "type": "skill_upload",
            "request_id": "conflict-1",
            "filename": "SKILL.md",
            "content_b64": encoded,
            "overwrite": False,
        },
    )
    conflict_payload = json.loads(connection.send.call_args.args[0])
    assert conflict_payload == {
        "event": "skill_mutation_error",
        "request_id": "conflict-1",
        "detail": "conflict",
        "name": "demo-skill",
    }

    connection.send.reset_mock()
    await channel._dispatch_envelope(
        connection,
        "webui-client",
        {"type": "skill_delete", "request_id": "delete-1", "name": "demo-skill"},
    )
    deleted = json.loads(connection.send.call_args.args[0])
    assert deleted == {
        "event": "skill_deleted",
        "request_id": "delete-1",
        "name": "demo-skill",
    }
    assert not (tmp_path / "skills/demo-skill").exists()


@pytest.mark.asyncio
async def test_skill_mutation_envelopes_use_stable_errors(tmp_path: Path) -> None:
    channel = _channel(tmp_path)
    connection = AsyncMock()

    await channel._dispatch_envelope(
        connection,
        "webui-client",
        {
            "type": "skill_upload",
            "request_id": "bad-1",
            "filename": "SKILL.md",
            "content_b64": "not base64",
        },
    )
    payload = json.loads(connection.send.call_args.args[0])
    assert payload == {
        "event": "skill_mutation_error",
        "request_id": "bad-1",
        "detail": "decode",
    }
    assert "path" not in payload

    connection.send.reset_mock()
    await channel._dispatch_envelope(
        connection,
        "webui-client",
        {"type": "skill_delete", "request_id": "bad-2", "name": "../outside"},
    )
    payload = json.loads(connection.send.call_args.args[0])
    assert payload["event"] == "skill_mutation_error"
    assert payload["request_id"] == "bad-2"
    assert payload["detail"] == "invalid_path"
