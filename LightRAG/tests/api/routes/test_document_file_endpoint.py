"""Tests for the /documents/file/{file_path} endpoint."""

import importlib
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

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
    from urllib.parse import quote
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

    from urllib.parse import quote

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

