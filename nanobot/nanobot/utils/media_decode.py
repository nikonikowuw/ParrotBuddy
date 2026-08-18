"""Shared helpers for decoding ``data:...;base64,...`` URLs to disk.

Historically lived in ``nanobot.api.server``; now shared by the WebSocket
channel so the ``api`` + ``websocket`` ingress paths apply the same parsing,
size guard, and filesystem layout.
"""

from __future__ import annotations

import base64
import mimetypes
import re
import uuid
from contextlib import suppress
from pathlib import Path

from nanobot.utils.helpers import safe_filename

DEFAULT_MAX_BYTES = 10 * 1024 * 1024
MAX_FILE_SIZE = DEFAULT_MAX_BYTES

_DATA_URL_RE = re.compile(r"^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$", re.DOTALL)
_MIME_EXTENSION_OVERRIDES = {
    # Office and PDF MIME types are explicit so uploads keep a parser-friendly
    # suffix on platforms whose ``mimetypes`` database is incomplete.
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    # Python's ``mimetypes`` maps browser-recorded audio/webm to ``.weba`` and
    # audio/ogg to ``.oga`` on macOS. Some transcription APIs validate by the
    # file extension and accept the canonical container extensions instead.
    "application/ogg": ".ogg",
    "audio/ogg": ".ogg",
    "audio/mpga": ".mpga",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "audio/x-m4a": ".m4a",
    "audio/x-wav": ".wav",
    "audio/vnd.wave": ".wav",
    "video/webm": ".webm",
}


class FileSizeExceededError(Exception):
    """Raised when a decoded payload exceeds the caller's size limit."""


FileSizeExceeded = FileSizeExceededError


def save_base64_data_url(
    data_url: str,
    media_dir: Path,
    *,
    max_bytes: int | None = None,
    filename: str | None = None,
) -> str | None:
    """Decode a ``data:<mime>;base64,<payload>`` URL and persist it.

    Returns the absolute path on success, ``None`` when the URL shape or the
    base64 payload itself is malformed. Raises :class:`FileSizeExceeded`
    when the decoded payload is larger than ``max_bytes`` (default 10 MB).
    When *filename* is provided, its sanitized basename is saved below a
    unique subdirectory so UI replays can retain the original display name.
    """
    m = _DATA_URL_RE.match(data_url)
    if not m:
        return None
    mime_type, b64_payload = m.group(1).strip().lower(), m.group(2)
    try:
        raw = base64.b64decode(b64_payload)
    except Exception:
        return None
    limit = DEFAULT_MAX_BYTES if max_bytes is None else max_bytes
    if len(raw) > limit:
        raise FileSizeExceeded(f"File exceeds {limit // (1024 * 1024)}MB limit")
    ext = _MIME_EXTENSION_OVERRIDES.get(mime_type) or mimetypes.guess_extension(mime_type) or ".bin"
    upload_dir: Path | None = None
    if filename:
        safe_name = safe_filename(Path(filename).name)
        if not safe_name or safe_name in {".", ".."}:
            safe_name = "attachment"
        if Path(safe_name).suffix.lower() != ext.lower():
            safe_name = f"{Path(safe_name).stem or 'attachment'}{ext}"
        upload_dir = media_dir / uuid.uuid4().hex[:12]
        upload_dir.mkdir(parents=True, exist_ok=False)
        dest = upload_dir / safe_name
    else:
        dest = media_dir / safe_filename(f"{uuid.uuid4().hex[:12]}{ext}")
    try:
        dest.write_bytes(raw)
    except Exception:
        if upload_dir is not None:
            with suppress(OSError):
                dest.unlink(missing_ok=True)
            with suppress(OSError):
                upload_dir.rmdir()
        raise
    return str(dest)
