"""Tests for context builder media handling.

The ContextBuilder renders image attachments as vision blocks. Non-image
attachments are referenced in the user text by AgentLoop and are read through
the read_file tool when the model requests them.
"""

from __future__ import annotations

from pathlib import Path

from nanobot.agent.context import ContextBuilder
from nanobot.utils.document import reference_non_image_attachments


def _make_builder(tmp_path: Path) -> ContextBuilder:
    """Create a minimal ContextBuilder for testing."""
    return ContextBuilder(workspace=tmp_path, timezone="UTC")


def test_build_user_content_with_no_media_returns_string(tmp_path: Path) -> None:
    builder = _make_builder(tmp_path)
    result = builder._build_user_content("hello", None)
    assert result == "hello"


def test_build_user_content_with_image_returns_list(tmp_path: Path) -> None:
    """Image files should produce base64 content blocks."""
    builder = _make_builder(tmp_path)
    png = tmp_path / "test.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    result = builder._build_user_content("describe this", [str(png)])
    assert isinstance(result, list)
    types = [b["type"] for b in result]
    assert "image_url" in types
    assert "text" in types


def test_build_user_content_ignores_non_image_files(tmp_path: Path) -> None:
    """Non-image files are read by the file tool, not the context builder."""
    builder = _make_builder(tmp_path)
    txt = tmp_path / "notes.txt"
    txt.write_text("some text", encoding="utf-8")
    result = builder._build_user_content("summarize", [str(txt)])
    assert result == "summarize"


def test_attachment_reference_reaches_context_without_injecting_body(tmp_path: Path) -> None:
    """Attachment references survive context construction until read_file runs."""
    builder = _make_builder(tmp_path)
    png = tmp_path / "chart.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    txt = tmp_path / "report.txt"
    txt.write_text("report text", encoding="utf-8")

    content, image_paths = reference_non_image_attachments(
        "analyze",
        [str(png), str(txt)],
    )
    result = builder._build_user_content(content, image_paths)

    assert isinstance(result, list)
    assert any(block["type"] == "image_url" for block in result)
    text_parts = [block.get("text", "") for block in result if block.get("type") == "text"]
    assert any(f"[Attachment: {txt}]" in text for text in text_parts)
    assert all("report text" not in text for text in text_parts)
