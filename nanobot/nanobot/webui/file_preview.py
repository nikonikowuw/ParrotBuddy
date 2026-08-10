"""Workspace-scoped source preview and raw-file payloads for the WebUI."""

from __future__ import annotations

import mimetypes
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from nanobot.security.workspace_access import WorkspaceScope
from nanobot.security.workspace_policy import WorkspaceBoundaryError, resolve_allowed_path

MAX_FILE_PREVIEW_BYTES = 384 * 1024

# Upper bound for the raw-file serving route. Keeps a single oversized
# document from exhausting gateway memory; media is served through the
# dedicated media route, not this one.
MAX_FILE_SERVE_BYTES = 256 * 1024 * 1024

# Upper bound for the file-save route. The WebUI transfers edited file
# content as base64 over the WebSocket, so this bounds gateway memory for a
# single save. 16 MB of decoded content (~22 MB base64) is ample for
# spreadsheet documents while staying well inside the frame limit.
MAX_FILE_SAVE_BYTES = 16 * 1024 * 1024

# ``application/*`` MIME types that are still plain text and should keep
# the text-preview path instead of being treated as binary documents.
_TEXT_LIKE_APPLICATION_MIMES = frozenset({
    "application/json",
    "application/javascript",
    "application/x-javascript",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
})


class WebUIFilePreviewError(ValueError):
    """Raised when a file cannot be previewed through the WebUI."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def file_preview_payload(
    raw_path: str | None,
    *,
    scope: WorkspaceScope,
    max_bytes: int = MAX_FILE_PREVIEW_BYTES,
) -> dict[str, Any]:
    """Return a preview payload for a file allowed by the session workspace scope.

    Text files produce a ``kind: "text"`` payload with ``content``; binary
    files (documents, media, PDFs, archives) produce ``kind: "binary"`` with
    the MIME type and filename so the WebUI can open or render them.
    """

    resolved = _resolve_file_path(raw_path, scope=scope)
    mime, _ = mimetypes.guess_type(resolved.name)

    display_path = _display_path(resolved, scope.project_path)
    if _is_known_binary_mime(mime):
        # Known non-text MIME (documents, media, PDFs, archives) — decide
        # binary-ness without reading the file content.
        return _binary_preview_payload(resolved, display_path, scope, mime)

    try:
        with open(resolved, "rb") as f:
            raw = f.read(max_bytes + 1)
    except OSError as e:
        raise WebUIFilePreviewError(500, "failed to read file") from e

    # Unknown extensions fall back to the NUL-byte heuristic over the head of
    # the file; only text-ish files need the full preview read above.
    if b"\0" in raw[:4096]:
        return _binary_preview_payload(resolved, display_path, scope, mime)

    truncated = len(raw) > max_bytes
    preview_bytes = raw[:max_bytes]
    try:
        content = preview_bytes.decode("utf-8")
    except UnicodeDecodeError:
        content = preview_bytes.decode("utf-8", errors="replace")

    return {
        "kind": "text",
        "path": str(resolved),
        "display_path": display_path,
        "project_path": str(scope.project_path),
        "language": _language_for_path(resolved),
        "content": content,
        "size": resolved.stat().st_size,
        "truncated": truncated,
    }


def serve_file_bytes(
    raw_path: str | None,
    *,
    scope: WorkspaceScope,
    max_bytes: int = MAX_FILE_SERVE_BYTES,
) -> tuple[bytes, str, str]:
    """Return ``(content, mime_type, filename)`` for a workspace-scoped file.

    Backs the WebUI raw-file route so binary artifacts (documents, PDFs,
    media) can be opened or downloaded in the browser. Applies the same
    workspace boundary checks as :func:`file_preview_payload` and rejects
    files larger than ``max_bytes`` (413) to bound gateway memory.
    """
    resolved = _resolve_file_path(raw_path, scope=scope)
    size = resolved.stat().st_size
    if size > max_bytes:
        raise WebUIFilePreviewError(413, "file is too large to serve")
    try:
        with open(resolved, "rb") as f:
            content = f.read()
    except OSError as e:
        raise WebUIFilePreviewError(500, "failed to read file") from e
    mime, _ = mimetypes.guess_type(resolved.name)
    return content, mime or "application/octet-stream", resolved.name


def write_file_bytes(
    raw_path: str | None,
    content: bytes,
    *,
    scope: WorkspaceScope,
    max_bytes: int = MAX_FILE_SAVE_BYTES,
) -> str:
    """Overwrite an existing workspace-scoped file with ``content``.

    Mirrors :func:`serve_file_bytes` path resolution so the same workspace
    boundary applies to writes: only files that already exist inside the
    scope can be overwritten (no arbitrary file creation). The write is
    atomic (temp file + fsync + rename) so a crash or power loss never
    leaves a truncated document behind. Returns the resolved absolute path.
    """
    resolved = _resolve_file_path(raw_path, scope=scope)
    if len(content) > max_bytes:
        raise WebUIFilePreviewError(413, "file is too large to save")
    # Unique temp name in the same directory: a predictable ``<name>.tmp``
    # would make two concurrent saves of the same file race on one path.
    fd, tmp_path = tempfile.mkstemp(
        dir=resolved.parent, prefix=resolved.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        # Preserve the original file's permission bits so an overwrite does
        # not silently widen (or narrow) access; apply before the rename so
        # the replacement is atomic with the mode change.
        os.chmod(tmp_path, stat.S_IMODE(resolved.stat().st_mode))
        os.replace(tmp_path, resolved)
        # fsync the directory so the rename itself is durable.
        try:
            dir_fd = os.open(str(resolved.parent), os.O_RDONLY)
        except OSError:
            dir_fd = None
        if dir_fd is not None:
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    except OSError as exc:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise WebUIFilePreviewError(500, "failed to write file") from exc
    return str(resolved)


def path_is_previewable(path: str | Path, *, scope: WorkspaceScope) -> bool:
    """Return True when ``path`` resolves to a file the preview/raw-file routes accept.

    Mirrors the exact resolution used by the WebUI preview routes, so the
    answer is guaranteed consistent with what a later preview request will
    do under the same scope (a path outside the boundary or a missing file
    is not previewable).
    """
    try:
        _resolve_file_path(str(path), scope=scope)
        return True
    except WebUIFilePreviewError:
        return False


def _resolve_file_path(raw_path: str | None, *, scope: WorkspaceScope) -> Path:
    """Resolve ``raw_path`` to an existing file inside the workspace scope."""
    path = _clean_preview_path(raw_path)
    if not path:
        raise WebUIFilePreviewError(400, "missing path")
    if len(path) > 4096:
        raise WebUIFilePreviewError(400, "path is too long")

    try:
        resolved = resolve_allowed_path(
            path,
            workspace=scope.project_path,
            allowed_root=scope.project_path if scope.restrict_to_workspace else None,
            strict=True,
        )
    except FileNotFoundError as e:
        raise WebUIFilePreviewError(404, "file not found") from e
    except WorkspaceBoundaryError as e:
        raise WebUIFilePreviewError(403, "file is outside the current workspace") from e
    except OSError as e:
        raise WebUIFilePreviewError(400, "invalid path") from e

    if not resolved.is_file():
        raise WebUIFilePreviewError(404, "file not found")
    return resolved


def _binary_preview_payload(
    resolved: Path,
    display_path: str,
    scope: WorkspaceScope,
    mime: str | None,
) -> dict[str, Any]:
    """Build the ``kind: "binary"`` payload for a file resolved inside scope."""
    return {
        "kind": "binary",
        "path": str(resolved),
        "display_path": display_path,
        "project_path": str(scope.project_path),
        "filename": resolved.name,
        "mime_type": mime or "application/octet-stream",
        "size": resolved.stat().st_size,
    }


def _is_known_binary_mime(mime: str | None) -> bool:
    """Return True when *mime* is a known non-text type (binary regardless of content).

    ``None`` and text-like MIME types (including ``application/*`` types that
    are still plain text) fall through to the NUL-byte heuristic so existing
    plain-text behavior is unchanged.
    """
    if mime is None or mime.startswith("text/") or mime in _TEXT_LIKE_APPLICATION_MIMES:
        return False
    return True


def _clean_preview_path(raw_path: str | None) -> str:
    if raw_path is None:
        return ""
    value = raw_path.strip()
    if not value:
        return ""
    if value.startswith("file://"):
        parsed = urlparse(value)
        value = unquote(parsed.path)
        if re.match(r"^/[A-Za-z]:[\\/]", value):
            value = value[1:]
    else:
        value = unquote(value)
    value = value.split("?", 1)[0].split("#", 1)[0].strip()
    if not re.match(r"^[A-Za-z]:[\\/]", value):
        value = re.sub(r":\d+(?::\d+)?$", "", value)
    return value


def _display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _language_for_path(path: Path) -> str:
    name = path.name.lower()
    ext = path.suffix.lower().lstrip(".")
    if name == "dockerfile":
        return "dockerfile"
    return {
        "cjs": "javascript",
        "css": "css",
        "cts": "typescript",
        "html": "html",
        "js": "javascript",
        "json": "json",
        "jsonl": "json",
        "jsx": "jsx",
        "md": "markdown",
        "mdx": "markdown",
        "mjs": "javascript",
        "mts": "typescript",
        "py": "python",
        "pyi": "python",
        "scss": "scss",
        "sh": "bash",
        "toml": "toml",
        "ts": "typescript",
        "tsx": "tsx",
        "yaml": "yaml",
        "yml": "yaml",
    }.get(ext, ext or "text")
