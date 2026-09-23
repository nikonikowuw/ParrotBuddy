"""Lightweight skill summaries for the WebUI."""

from __future__ import annotations

import io
import os
import re
import shutil
import stat
import tempfile
import threading
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from nanobot.agent.skills import SkillsLoader


def webui_skills_payload(
    workspace_path: Path,
    *,
    disabled_skills: set[str] | None = None,
) -> dict[str, Any]:
    """Return agent skills without leaking local filesystem paths."""
    loader = SkillsLoader(workspace_path, disabled_skills=disabled_skills)
    entries = sorted(
        loader.list_skills(filter_unavailable=False),
        key=lambda entry: (entry.get("source") != "workspace", entry["name"]),
    )
    return {"skills": [_skill_payload(loader, entry) for entry in entries]}


def webui_skill_detail_payload(
    workspace_path: Path,
    name: str,
    *,
    disabled_skills: set[str] | None = None,
) -> dict[str, Any] | None:
    """Return a single skill's safe detail payload."""
    loader = SkillsLoader(workspace_path, disabled_skills=disabled_skills)
    entries = loader.list_skills(filter_unavailable=False)
    entry = next((item for item in entries if item["name"] == name), None)
    if entry is None:
        return None
    return {
        **_skill_payload(loader, entry),
        "requirements": loader.get_skill_requirements(name),
        "raw_markdown": loader.load_skill(name) or "",
    }


def _skill_payload(loader: SkillsLoader, entry: dict[str, str]) -> dict[str, Any]:
    name = entry["name"]
    metadata = loader.get_skill_metadata(name)
    available, unavailable_reason = loader.get_skill_availability(name)
    return {
        "name": name,
        "description": _description(metadata, name),
        "source": entry.get("source", "unknown"),
        "available": available,
        "unavailable_reason": unavailable_reason,
    }

def _description(metadata: dict[str, Any] | None, fallback: str) -> str:
    if metadata is None:
        return fallback
    value = metadata.get("description")
    return value.strip() if isinstance(value, str) and value.strip() else fallback


MAX_SKILL_UPLOAD_BYTES = 16 * 1024 * 1024
MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_SKILL_ARCHIVE_MEMBER_BYTES = 8 * 1024 * 1024
MAX_SKILL_ARCHIVE_MEMBERS = 256
MAX_SKILL_NAME_LENGTH = 64

_ALLOWED_FRONTMATTER_KEYS = {
    "name",
    "description",
    "metadata",
    "always",
    "license",
    "allowed-tools",
    "homepage",
    "version",
    "author",
    "tags",
}
_ALLOWED_ROOT_FILES = {
    "SKILL.md",
    "README.md",
    "README",
    "README.txt",
    "LICENSE",
    "LICENSE.txt",
    "LICENSE.md",
    "requirements.txt",
    "package.json",
    "metadata.json",
}
_ALLOWED_RESOURCE_DIRS = {
    "scripts",
    "references",
    "assets",
    "templates",
    "examples",
    "schemas",
    "styles",
}
_IGNORED_SEGMENT_NAMES = {
    ".ds_store",
    "thumbs.db",
    "desktop.ini",
    ".git",
    ".gitignore",
    ".gitattributes",
    ".clawhubignore",
    "__pycache__",
    "node_modules",
    ".venv",
    "env",
}
_IGNORED_EXTENSIONS = (".pyc", ".pyo", ".swp", ".swo")
_SKILL_NAME_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_SKILL_FRONTMATTER_RE = re.compile(
    r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?",
    re.DOTALL,
)
_SKILL_MUTATION_LOCK = threading.Lock()


class SkillMutationError(ValueError):
    """A safe, stable error token for a WebUI skill mutation."""

    def __init__(self, token: str, *, name: str = ""):
        super().__init__(token)
        self.token = token
        self.name = name


def _is_ignored_member(parts: list[str]) -> bool:
    for part in parts:
        lower = part.lower()
        if lower in _IGNORED_SEGMENT_NAMES:
            return True
        if part.startswith("._") or lower.endswith(_IGNORED_EXTENSIONS):
            return True
    return False


def upload_workspace_skill(
    workspace_path: Path,
    filename: str,
    content: bytes,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Validate and atomically install or update one workspace skill."""
    if not isinstance(filename, str) or not filename:
        raise SkillMutationError("invalid_file")
    if filename not in {"SKILL.md"} and not filename.endswith(".skill"):
        raise SkillMutationError("invalid_file")
    if len(filename) > 255 or "/" in filename or "\\" in filename or "\x00" in filename:
        raise SkillMutationError("invalid_file")
    if not isinstance(content, bytes):
        raise SkillMutationError("invalid_file")
    if len(content) > MAX_SKILL_UPLOAD_BYTES:
        raise SkillMutationError("size")

    with _SKILL_MUTATION_LOCK:
        skills_root = _workspace_skills_dir(workspace_path, create=True)
        staging_parent = Path(tempfile.mkdtemp(prefix=".skill-upload-", dir=skills_root))
        try:
            if filename == "SKILL.md":
                name = _parse_skill_markdown(content)
                staging = staging_parent / name
                staging.mkdir()
                (staging / "SKILL.md").write_bytes(content)
            else:
                staging = _extract_skill_archive(content, staging_parent)
                name = _validate_skill_tree(staging)

            target = skills_root / name
            is_update = False
            if os.path.lexists(target):
                if target.is_symlink():
                    raise SkillMutationError("forbidden")
                if not overwrite:
                    raise SkillMutationError("conflict", name=name)
                is_update = True

            if is_update:
                backup = staging_parent / f".backup-{name}"
                os.replace(target, backup)
                try:
                    os.replace(staging, target)
                except Exception:
                    if os.path.lexists(backup):
                        os.replace(backup, target)
                    raise
            else:
                os.replace(staging, target)

            loader = SkillsLoader(workspace_path)
            available, unavailable_reason = loader.get_skill_availability(name)
            requirements = loader.get_skill_requirements(name)
            return {
                "name": name,
                "updated": is_update,
                "available": available,
                "unavailable_reason": unavailable_reason,
                "requirements": requirements,
            }
        except SkillMutationError:
            raise
        except (zipfile.BadZipFile, EOFError, RuntimeError):
            raise SkillMutationError("invalid_skill") from None
        except (OSError, ValueError, yaml.YAMLError):
            raise SkillMutationError("failed") from None
        finally:
            shutil.rmtree(staging_parent, ignore_errors=True)


def delete_workspace_skill(workspace_path: Path, name: str) -> str:
    """Delete one workspace skill, never a built-in or arbitrary path."""
    normalized_name = _validate_skill_name(name)
    with _SKILL_MUTATION_LOCK:
        skills_root = _workspace_skills_dir(workspace_path, create=False)
        target = skills_root / normalized_name if skills_root is not None else None
        if target is None or not os.path.lexists(target):
            builtin_path = SkillsLoader(workspace_path).builtin_skills / normalized_name
            if (builtin_path / "SKILL.md").is_file():
                raise SkillMutationError("forbidden")
            raise SkillMutationError("not_found")

        if target.is_symlink() or not target.is_dir():
            raise SkillMutationError("forbidden")
        try:
            shutil.rmtree(target)
        except OSError:
            raise SkillMutationError("failed") from None
        return normalized_name


def _workspace_skills_dir(workspace_path: Path, *, create: bool) -> Path | None:
    root = Path(workspace_path).expanduser()
    if not root.is_dir():
        raise SkillMutationError("forbidden")
    root = root.resolve()
    skills_root = root / "skills"
    if not os.path.lexists(skills_root):
        if not create:
            return None
        try:
            skills_root.mkdir()
        except OSError:
            raise SkillMutationError("failed") from None
    if skills_root.is_symlink() or not skills_root.is_dir():
        raise SkillMutationError("forbidden")
    return skills_root


def _validate_skill_name(name: Any) -> str:
    if not isinstance(name, str) or not name or len(name) > MAX_SKILL_NAME_LENGTH:
        raise SkillMutationError("invalid_path")
    if _SKILL_NAME_RE.fullmatch(name) is None:
        raise SkillMutationError("invalid_path")
    return name


def _parse_skill_markdown(content: bytes) -> str:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise SkillMutationError("invalid_skill") from None
    match = _SKILL_FRONTMATTER_RE.match(text)
    if match is None:
        raise SkillMutationError("invalid_skill")
    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        raise SkillMutationError("invalid_skill") from None
    if not isinstance(frontmatter, dict) or any(
        not isinstance(key, str) for key in frontmatter
    ):
        raise SkillMutationError("invalid_skill")
    unexpected = set(frontmatter) - _ALLOWED_FRONTMATTER_KEYS
    if unexpected or "name" not in frontmatter or "description" not in frontmatter:
        raise SkillMutationError("invalid_skill")

    raw_name = frontmatter["name"]
    if not isinstance(raw_name, str):
        raise SkillMutationError("invalid_skill")
    name = raw_name.strip()
    _validate_skill_name(name)

    description = frontmatter["description"]
    if not isinstance(description, str):
        raise SkillMutationError("invalid_skill")
    description = description.strip()
    if (
        not description
        or len(description) > 1024
        or "<" in description
        or ">" in description
        or any(marker in description.lower() for marker in ("[todo", "todo:"))
    ):
        raise SkillMutationError("invalid_skill")
    if "always" in frontmatter and not isinstance(frontmatter["always"], bool):
        raise SkillMutationError("invalid_skill")
    return name


def _validate_skill_tree(skill_root: Path) -> str:
    if skill_root.is_symlink() or not skill_root.is_dir():
        raise SkillMutationError("invalid_skill")
    name = _validate_skill_name(skill_root.name)
    skill_file = skill_root / "SKILL.md"
    if skill_file.is_symlink() or not skill_file.is_file():
        raise SkillMutationError("invalid_skill")
    parsed_name = _parse_skill_markdown(skill_file.read_bytes())
    if parsed_name != name:
        raise SkillMutationError("invalid_skill")

    for child in skill_root.iterdir():
        if child.name.lower() in _IGNORED_SEGMENT_NAMES or child.name.startswith("._"):
            continue
        if child.is_symlink():
            raise SkillMutationError("forbidden")
        if child.is_file():
            if child.name not in _ALLOWED_ROOT_FILES:
                raise SkillMutationError("invalid_skill")
        elif child.is_dir():
            if child.name not in _ALLOWED_RESOURCE_DIRS:
                raise SkillMutationError("invalid_skill")
            for descendant in child.rglob("*"):
                if descendant.is_symlink():
                    raise SkillMutationError("forbidden")
                if not descendant.is_file() and not descendant.is_dir():
                    raise SkillMutationError("invalid_skill")
        else:
            raise SkillMutationError("invalid_skill")
    return name


def _extract_skill_archive(content: bytes, destination: Path) -> Path:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (OSError, zipfile.BadZipFile):
        raise SkillMutationError("invalid_skill") from None

    seen: set[str] = set()
    root_names: set[str] = set()
    total_uncompressed = 0
    try:
        members = archive.infolist()
        if not members or len(members) > MAX_SKILL_ARCHIVE_MEMBERS:
            raise SkillMutationError("invalid_skill")
        valid_members: list[tuple[zipfile.ZipInfo, str, bool]] = []
        for info in members:
            raw_name = info.filename
            if raw_name.startswith("__MACOSX/") or "/__MACOSX/" in raw_name:
                continue
            is_dir = info.is_dir() or raw_name.endswith("/")
            normalized = raw_name[:-1] if is_dir and raw_name.endswith("/") else raw_name
            if (
                not normalized
                or raw_name.startswith("/")
                or "\\" in raw_name
                or "\x00" in raw_name
            ):
                raise SkillMutationError("invalid_path")
            parts = normalized.split("/")
            if any(not part or part in {".", ".."} for part in parts):
                raise SkillMutationError("invalid_path")
            if _is_ignored_member(parts):
                continue
            rel = PurePosixPath(*parts).as_posix()
            if rel in seen:
                raise SkillMutationError("invalid_skill")
            seen.add(rel)
            root_names.add(parts[0])
            if len(parts) == 1 and not is_dir:
                raise SkillMutationError("invalid_skill")
            if len(parts) == 2:
                if not is_dir and parts[1] not in _ALLOWED_ROOT_FILES:
                    raise SkillMutationError("invalid_skill")
                if is_dir and parts[1] not in _ALLOWED_RESOURCE_DIRS:
                    raise SkillMutationError("invalid_skill")
            elif len(parts) > 2:
                if parts[1] not in _ALLOWED_RESOURCE_DIRS:
                    raise SkillMutationError("invalid_skill")
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_IFMT(mode) == stat.S_IFLNK:
                raise SkillMutationError("forbidden")
            if info.file_size < 0 or info.file_size > MAX_SKILL_ARCHIVE_MEMBER_BYTES:
                raise SkillMutationError("size")
            total_uncompressed += info.file_size
            if total_uncompressed > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES:
                raise SkillMutationError("size")
            valid_members.append((info, normalized, is_dir))
        if len(root_names) != 1:
            raise SkillMutationError("invalid_skill")
        root_name = next(iter(root_names))
        _validate_skill_name(root_name)

        total_uncompressed_written = 0
        for info, normalized, is_dir in valid_members:
            target = destination.joinpath(*normalized.split("/"))
            if is_dir:
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with archive.open(info, "r") as source, target.open("wb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    total_uncompressed_written += len(chunk)
                    if (
                        written > MAX_SKILL_ARCHIVE_MEMBER_BYTES
                        or total_uncompressed_written > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES
                    ):
                        raise SkillMutationError("size")
                    output.write(chunk)
        root = destination / root_name
        return root
    finally:
        archive.close()
