import json

import pytest

from nanobot.config.loader import load_config
from nanobot.config.schema import ApiConfig, Config


def test_load_config_missing_file_uses_defaults(tmp_path) -> None:
    config = load_config(tmp_path / "missing.json")

    assert config.agents.defaults.model


def test_load_config_invalid_json_fails_fast(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{broken json", encoding="utf-8")

    with pytest.raises(ValueError, match="Failed to load config"):
        load_config(config_path)


def test_load_config_invalid_schema_fails_fast(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({"tools": {"exec": {"timeout": -1}}}),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Failed to load config"):
        load_config(config_path)


@pytest.mark.parametrize("host", ["0.0.0.0", "::"])
def test_api_config_requires_key_for_wildcard_hosts(host: str) -> None:
    with pytest.raises(ValueError, match="api_key is not set"):
        ApiConfig(host=host)


def test_api_config_allows_wildcard_host_with_key() -> None:
    config = ApiConfig(host="0.0.0.0", api_key="secret")

    assert config.host == "0.0.0.0"
    assert config.api_key == "secret"


def test_load_config_migrates_legacy_lightrag_workspaces(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({
            "tools": {
                "lightrag": {
                    "enabled": True,
                    "apiBase": "http://127.0.0.1:9621",
                    "apiKey": "legacy-key",
                    "workspaces": ["docs", "research"],
                    "defaultQueryMode": "hybrid",
                    "defaultTopK": 20,
                    "timeout": 45,
                    "proxy": "http://proxy.test:8080",
                    "includeReferences": False,
                    "includeChunkContent": True,
                }
            }
        }),
        encoding="utf-8",
    )

    config = load_config(config_path)
    lightrag = config.tools.lightrag
    assert lightrag.enabled is True
    assert [server.name for server in lightrag.servers] == ["docs", "research"]
    assert lightrag.default_workspace == "docs"
    docs = lightrag.servers[0]
    assert docs.api_base == "http://127.0.0.1:9621"
    assert docs.api_key == "legacy-key"
    assert docs.default_query_mode == "hybrid"
    assert docs.default_top_k == 20
    assert docs.timeout == 45
    assert docs.proxy == "http://proxy.test:8080"
    assert docs.include_references is False
    assert docs.include_chunk_content is True


def test_load_config_localizes_legacy_personal_default_name(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({
            "tools": {
                "lightrag": {
                    "enabled": True,
                    "personal": {
                        "enabled": True,
                        "name": "Personal Knowledge Base",
                        "apiBase": "http://127.0.0.1:9621",
                    },
                    "enterprise_servers": [
                        {"name": "docs", "api_base": "http://127.0.0.1:9622"}
                    ],
                    "default_workspace": "Personal Knowledge Base",
                }
            }
        }),
        encoding="utf-8",
    )

    config = load_config(config_path)

    assert config.tools.lightrag.personal.name is None
    assert config.tools.lightrag.default_workspace == "__personal__"
    assert [server.name for server in config.tools.lightrag.enterprise_servers] == ["docs"]


def test_load_config_normalizes_legacy_lightrag_default_workspace_sentinel(
    tmp_path,
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({
            "tools": {
                "lightrag": {
                    "enabled": True,
                    "default_workspace": "__default__",
                    "servers": [{"name": "docs", "api_base": "http://127.0.0.1:9621"}],
                }
            }
        }),
        encoding="utf-8",
    )

    config = load_config(config_path)
    lightrag = config.tools.lightrag
    assert [server.name for server in lightrag.servers] == ["docs"]
    assert lightrag.default_workspace == "docs"


def test_load_config_migrates_legacy_lightrag_without_workspaces(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({
            "tools": {
                "lightrag": {
                    "enabled": True,
                    "apiBase": "http://127.0.0.1:9621",
                    "defaultWorkspace": "main",
                }
            }
        }),
        encoding="utf-8",
    )

    config = load_config(config_path)
    lightrag = config.tools.lightrag
    assert [server.name for server in lightrag.servers] == ["main"]
    assert lightrag.default_workspace == "main"


def test_load_config_migrates_legacy_lightrag_dedupes_workspaces(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({
            "tools": {
                "lightrag": {
                    "enabled": True,
                    "apiBase": "http://127.0.0.1:9621",
                    "workspaces": ["docs", "docs", "research"],
                }
            }
        }),
        encoding="utf-8",
    )

    config = load_config(config_path)
    lightrag = config.tools.lightrag
    assert [server.name for server in lightrag.servers] == ["docs", "research"]
    assert lightrag.default_workspace == "docs"


def test_default_config_has_lightrag_enabled_by_default() -> None:
    config = Config()
    assert config.tools.lightrag.enabled is True
    assert config.tools.lightrag.personal.enabled is True
    assert config.tools.lightrag.personal.api_base == "http://127.0.0.1:9621"
