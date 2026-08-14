"""Tests for the /documents/file/{file_path} endpoint."""

import importlib
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from urllib.parse import quote

_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
_document_routes = importlib.import_module("lightrag.api.routers.document_routes")
sys.argv = _original_argv

create_document_routes = _document_routes.create_document_routes
DocumentManager = _document_routes.DocumentManager

pytestmark = pytest.mark.offline


@pytest.fixture
def test_env(tmp_path):
    input_dir = tmp_path / "inputs"
    input_dir.mkdir()
    
    test_file = input_dir / "发票文件.pdf"
    test_file.write_bytes(b"%PDF-1.4 test invoice content")
    
    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")
    
    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    
    return client, input_dir, test_file


def test_get_document_file_success(test_env):
    client, input_dir, test_file = test_env
    
    # Test encoded filename access
    encoded_name = quote("发票文件.pdf")
    
    res = client.get(f"/documents/file/{encoded_name}")
    assert res.status_code == 200
    assert res.content == b"%PDF-1.4 test invoice content"
    assert "filename*=utf-8''%E5%8F%91%E7%A5%A8%E6%96%87%E4%BB%B6.pdf" in res.headers.get("content-disposition", "") or "发票文件.pdf" in res.headers.get("content-disposition", "")


def test_get_document_file_in_parsed_dir(tmp_path):
    input_dir = tmp_path / "inputs"
    parsed_dir = input_dir / "__parsed__"
    parsed_dir.mkdir(parents=True)

    parsed_file = parsed_dir / "发票文件_001.pdf"
    parsed_file.write_bytes(b"%PDF-1.4 parsed file content")

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    res = client.get(f"/documents/file/{quote('发票文件.pdf')}")
    assert res.status_code == 200
    assert res.content == b"%PDF-1.4 parsed file content"


def test_get_document_file_not_found(test_env):
    client, input_dir, test_file = test_env
    res = client.get("/documents/file/nonexistent.pdf")
    assert res.status_code == 404
    assert "not found" in res.json()["detail"]


def test_get_document_file_path_traversal_blocked(tmp_path):
    input_dir = tmp_path / "inputs"
    input_dir.mkdir()

    secret_file = tmp_path / "secret.txt"
    secret_file.write_text("sensitive root data")

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    # Attempt relative path traversal
    res = client.get("/documents/file/../secret.txt")
    assert res.status_code == 404

    # Attempt absolute path traversal
    res = client.get(f"/documents/file/{secret_file}")
    assert res.status_code == 404



def test_get_parsed_asset_inside_artifact_dir(tmp_path):
    """A sidecar media path like demo.blocks.assets/image.png must resolve
    inside the matching demo.pdf.parsed artifact directory and return the
    image bytes with an image content type."""
    input_dir = tmp_path / "inputs"
    artifact_dir = input_dir / "__parsed__" / "demo.pdf.parsed"
    asset_dir = artifact_dir / "demo.blocks.assets"
    asset_dir.mkdir(parents=True)

    png_bytes = b"\x89PNG\r\n\x1a\nfake-image-content"
    (asset_dir / "image.png").write_bytes(png_bytes)

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    res = client.get(f"/documents/file/{quote('demo.blocks.assets/image.png')}")
    assert res.status_code == 200
    assert res.content == png_bytes
    assert res.headers.get("content-type", "").startswith("image/png")


def test_get_parsed_asset_missing_returns_404(tmp_path):
    input_dir = tmp_path / "inputs"
    artifact_dir = input_dir / "__parsed__" / "demo.pdf.parsed"
    artifact_dir.mkdir(parents=True)

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    res = client.get(f"/documents/file/{quote('demo.blocks.assets/nope.png')}")
    assert res.status_code == 404


def test_get_parsed_asset_rejects_traversal_and_absolute(tmp_path):
    """Parsed-asset lookup must not escape configured roots: traversal and
    absolute media paths are rejected even when a sibling artifact dir
    exists."""
    input_dir = tmp_path / "inputs"
    artifact_dir = input_dir / "__parsed__" / "demo.pdf.parsed"
    artifact_dir.mkdir(parents=True)

    secret = tmp_path / "secret.png"
    secret.write_bytes(b"secret bytes")

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    # Relative traversal out of the parsed root.
    res = client.get("/documents/file/../secret.png")
    assert res.status_code == 404

    # Traversal inside a media path.
    res = client.get(f"/documents/file/{quote('demo.blocks.assets/../../secret.png')}")
    assert res.status_code == 404

    # Absolute path (FastAPI normalizes; verify it still cannot escape).
    res = client.get(f"/documents/file/{quote(str(secret))}")
    assert res.status_code == 404


def test_get_parsed_asset_in_numbered_artifact_dir(tmp_path):
    """Media assets must also resolve under numbered archive artifact dirs
    (``demo.pdf.parsed_001``) — the sidecar writer appends ``_NNN`` when the
    base artifact directory name is already taken."""
    input_dir = tmp_path / "inputs"
    artifact_dir = input_dir / "__parsed__" / "demo.pdf.parsed_001"
    asset_dir = artifact_dir / "demo.blocks.assets"
    asset_dir.mkdir(parents=True)

    png_bytes = b"\x89PNG\r\n\x1a\nfake-image-content"
    (asset_dir / "image.png").write_bytes(png_bytes)

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    res = client.get(f"/documents/file/{quote('demo.blocks.assets/image.png')}")
    assert res.status_code == 200
    assert res.content == png_bytes
    assert res.headers.get("content-type", "").startswith("image/png")


def test_get_parsed_asset_rejects_url_and_drive_schemes(tmp_path):
    """Media paths that look like URL schemes or Windows drive letters must
    not resolve to any file (404), even if an artifact dir exists."""
    input_dir = tmp_path / "inputs"
    artifact_dir = input_dir / "__parsed__" / "demo.pdf.parsed"
    artifact_dir.mkdir(parents=True)

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    res = client.get(f"/documents/file/{quote('http://evil.example/x.png')}")
    assert res.status_code == 404

    drive_path = "C:\\Windows\\x.png"
    res = client.get(f"/documents/file/{quote(drive_path)}")
    assert res.status_code == 404


def test_get_parsed_asset_cached_repeat_request_and_no_stale_serve(tmp_path):
    """Cached parsed-asset lookups must (1) keep serving the asset on repeated
    requests and (2) never serve a deleted asset from a stale cache entry —
    the cached resolution is re-validated against the live filesystem."""
    input_dir = tmp_path / "inputs"
    artifact_dir = input_dir / "__parsed__" / "demo.pdf.parsed"
    asset_dir = artifact_dir / "demo.blocks.assets"
    asset_dir.mkdir(parents=True)

    png_bytes = b"\x89PNG\r\n\x1a\nfake-image-content"
    asset_file = asset_dir / "image.png"
    asset_file.write_bytes(png_bytes)

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    # First request populates the resolution + listing caches.
    res = client.get(f"/documents/file/{quote('demo.blocks.assets/image.png')}")
    assert res.status_code == 200
    assert res.content == png_bytes

    # Repeated request must still be served (cache hit path).
    res = client.get(f"/documents/file/{quote('demo.blocks.assets/image.png')}")
    assert res.status_code == 200
    assert res.content == png_bytes

    # Delete the asset: the cached resolution must NOT be served as-is.
    asset_file.unlink()
    res = client.get(f"/documents/file/{quote('demo.blocks.assets/image.png')}")
    assert res.status_code == 404


def test_get_parsed_asset_fresh_scan_finds_reparsed_dir(tmp_path):
    """A stale cached artifact-dir listing must never cause a false 404: after
    a document is re-parsed (old ``*.parsed`` dir replaced by a numbered
    ``*.parsed_001``), the fresh-scan fallback finds the asset even while the
    listing cache still holds the old dir set."""
    from lightrag.api.routers.document_routes import (
        _parsed_artifact_dirs_cache,
        _parsed_media_resolution_cache,
    )

    input_dir = tmp_path / "inputs"
    parsed_root = input_dir / "__parsed__"
    new_artifact = parsed_root / "demo.pdf.parsed_001"
    new_asset_dir = new_artifact / "demo.blocks.assets"
    new_asset_dir.mkdir(parents=True)
    png_bytes = b"\x89PNG\r\n\x1a\nreparsed-image-content"
    (new_asset_dir / "image.png").write_bytes(png_bytes)

    doc_manager = DocumentManager(input_dir=str(input_dir))
    fake_rag = SimpleNamespace(workspace="")

    router = create_document_routes(fake_rag, doc_manager, api_key=None)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    # Seed a stale listing cache: only the OLD artifact dir is known, so a
    # cache-only scan would miss the asset that now lives in the _001 dir.
    resolved_root = parsed_root.resolve()
    _parsed_artifact_dirs_cache[str(resolved_root)] = (
        0.0,
        ["demo.pdf.parsed"],
    )
    _parsed_media_resolution_cache.clear()

    res = client.get(f"/documents/file/{quote('demo.blocks.assets/image.png')}")
    assert res.status_code == 200, "fresh-scan fallback must find the re-parsed asset"
    assert res.content == png_bytes
