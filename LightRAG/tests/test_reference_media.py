"""Regression tests for additive retrieved-media metadata.

Covers the contract that keeps the parent document path in ``file_path``
while exposing retrieved images as nested ``media`` objects:

1. ``generate_reference_list_from_chunks`` groups by the parent ``file_path``
   and aggregates / deduplicates media from the grouped chunks.
2. ``convert_to_user_format`` carries the chunk-level media metadata into the
   user-facing data payload.
"""

import asyncio

import pytest

from lightrag.utils import convert_to_user_format, generate_reference_list_from_chunks

pytestmark = pytest.mark.offline


def _media(path, name="fig", desc="indexed description"):
    return {"type": "image", "path": path, "format": "png", "name": name, "description": desc}


def test_reference_aggregates_media_and_keeps_parent_path():
    chunks = [
        {"file_path": "demo.pdf", "content": "c1", "media": [_media("demo.blocks.assets/image.png")]},
        {"file_path": "demo.pdf", "content": "c2", "media": [_media("demo.blocks.assets/other.png")]},
    ]
    reference_list, updated = generate_reference_list_from_chunks(chunks)

    assert len(reference_list) == 1
    ref = reference_list[0]
    # Parent provenance is preserved; the asset path never replaces it.
    assert ref["file_path"] == "demo.pdf"
    assert ref["reference_id"] == "1"
    media = ref["media"]
    assert len(media) == 2
    assert {m["path"] for m in media} == {
        "demo.blocks.assets/image.png",
        "demo.blocks.assets/other.png",
    }
    # Both chunks keep the parent file_path and their own media.
    assert all(c["file_path"] == "demo.pdf" for c in updated)
    assert all(c.get("media") for c in updated)


def test_reference_deduplicates_media_by_type_and_path():
    chunks = [
        {"file_path": "demo.pdf", "content": "c1", "media": [_media("demo.blocks.assets/image.png")]},
        {"file_path": "demo.pdf", "content": "c2", "media": [_media("demo.blocks.assets/image.png", name="dup")]},
    ]
    reference_list, _ = generate_reference_list_from_chunks(chunks)

    media = reference_list[0]["media"]
    assert len(media) == 1
    assert media[0]["path"] == "demo.blocks.assets/image.png"
    # First occurrence wins (stable ordering).
    assert media[0]["name"] == "fig"


def test_reference_without_media_has_no_media_field():
    chunks = [
        {"file_path": "demo.pdf", "content": "plain text chunk"},
    ]
    reference_list, _ = generate_reference_list_from_chunks(chunks)

    assert len(reference_list) == 1
    ref = reference_list[0]
    assert ref["file_path"] == "demo.pdf"
    assert "media" not in ref


def test_reference_frequency_ordering_preserved():
    chunks = [
        {"file_path": "b.txt", "content": "b1"},
        {"file_path": "a.pdf", "content": "a1", "media": [_media("a.blocks.assets/img.png")]},
        {"file_path": "a.pdf", "content": "a2"},
    ]
    reference_list, _ = generate_reference_list_from_chunks(chunks)

    # a.pdf appears twice, so it sorts first despite first appearing second.
    assert [ref["file_path"] for ref in reference_list] == ["a.pdf", "b.txt"]
    assert reference_list[0]["media"][0]["path"] == "a.blocks.assets/img.png"


def test_convert_to_user_format_carries_chunk_media():
    chunks = [
        {
            "reference_id": "1",
            "content": "c1",
            "file_path": "demo.pdf",
            "media": [_media("demo.blocks.assets/image.png")],
        },
        {
            "reference_id": "1",
            "content": "plain chunk",
            "file_path": "demo.pdf",
        },
    ]
    data = convert_to_user_format([], [], chunks, [], "hybrid")

    formatted = data["data"]["chunks"]
    assert formatted[0]["file_path"] == "demo.pdf"
    assert formatted[0]["media"][0]["path"] == "demo.blocks.assets/image.png"
    # Chunks without media keep working with no media key.
    assert "media" not in formatted[1]


def test_get_vector_context_hydrates_media_from_text_chunks():
    """Vector results only carry the chunk VDB meta_fields (content / file_path /
    full_doc_id); the additive ``media`` metadata is hydrated from text_chunks so
    a retrieved multimodal chunk keeps its image through to reference
    aggregation."""
    from lightrag.base import QueryParam
    from lightrag.operate import _get_vector_context, _hydrate_chunk_media
    from tests.tools.test_rebuild_vdb import MockVDB

    class _ChunksVDB(MockVDB):
        cosine_better_than_threshold = 0.2

        async def query(self, query, top_k, query_embedding=None):
            return [
                {"id": "chunk-1", "content": "c1", "file_path": "demo.pdf"},
                {"id": "chunk-2", "content": "c2", "file_path": "demo.pdf"},
            ]

    class _TextChunks:
        async def get_by_ids(self, ids):
            return [
                {
                    "content": "c1",
                    "file_path": "demo.pdf",
                    "media": [_media("demo.blocks.assets/image.png")],
                },
                {"content": "c2", "file_path": "demo.pdf"},
            ]

    chunks = asyncio.run(_get_vector_context("q", _ChunksVDB(), QueryParam(top_k=5)))
    chunks = asyncio.run(_hydrate_chunk_media(chunks, _TextChunks()))
    assert chunks[0]["chunk_id"] == "chunk-1"
    assert chunks[0]["media"][0]["path"] == "demo.blocks.assets/image.png"
    assert "media" not in chunks[1]


async def test_merge_all_chunks_preserves_vector_media():
    """The round-robin merge must copy the additive media metadata from
    retrieved chunks instead of rebuilding a content/file_path-only dict,
    otherwise every retrieval mode drops the images before reference
    aggregation."""
    from lightrag.base import QueryParam
    from lightrag.operate import _merge_all_chunks

    vector_chunks = [
        {
            "content": "c1",
            "file_path": "demo.pdf",
            "chunk_id": "chunk-a",
            "media": [_media("demo.blocks.assets/image.png")],
        },
        {
            "content": "c2",
            "file_path": "demo.pdf",
            "chunk_id": "chunk-b",
        },
    ]

    merged = await _merge_all_chunks(
        filtered_entities=[],
        filtered_relations=[],
        vector_chunks=vector_chunks,
        query="q",
        query_param=QueryParam(top_k=5),
    )

    assert len(merged) == 2
    assert merged[0]["chunk_id"] == "chunk-a"
    assert merged[0]["media"][0]["path"] == "demo.blocks.assets/image.png"
    assert "media" not in merged[1]
    assert all(m["file_path"] == "demo.pdf" for m in merged)


def _media_flag_workspace():
    from lightrag import operate

    operate._workspace_has_media.clear()
    operate._workspace_freshness_checked.clear()
    return operate


def test_hydrate_skipped_when_workspace_known_media_free():
    """When the has-media flag is False the hydration round-trip is skipped
    entirely (get_by_ids must not be called)."""
    from lightrag.operate import _hydrate_chunk_media

    operate = _media_flag_workspace()
    operate._workspace_has_media["ws"] = False

    calls = []

    class _TextChunks:
        workspace = "ws"

        async def get_by_ids(self, ids):
            calls.append(ids)
            return [{} for _ in ids]

    chunks = [{"chunk_id": "c1", "content": "x", "file_path": "f"}]
    result = asyncio.run(_hydrate_chunk_media(chunks, _TextChunks()))
    assert result == chunks
    assert calls == []


def test_hydrate_runs_when_workspace_has_media():
    """A workspace flagged as media-bearing keeps hydrating every query."""
    from lightrag.operate import _hydrate_chunk_media

    operate = _media_flag_workspace()
    operate._workspace_has_media["ws"] = True

    calls = []

    class _TextChunks:
        workspace = "ws"

        async def get_by_ids(self, ids):
            calls.append(ids)
            return [{"media": [_media("img.png")]} for _ in ids]

    chunks = [{"chunk_id": "c1", "content": "x", "file_path": "f"}]
    result = asyncio.run(_hydrate_chunk_media(chunks, _TextChunks()))
    assert calls == [["c1"]]
    assert result[0]["media"][0]["path"] == "img.png"


def test_hydrate_unknown_detects_media_and_flags_workspace():
    """An unknown workspace hydrates and, when media is found, marks the
    workspace as media-bearing for subsequent queries."""
    from lightrag.operate import _hydrate_chunk_media

    operate = _media_flag_workspace()

    class _TextChunks:
        workspace = "ws"

        async def get_by_ids(self, ids):
            return [{"media": [_media("img.png")]} for _ in ids]

    chunks = [{"chunk_id": "c1", "content": "x", "file_path": "f"}]
    result = asyncio.run(_hydrate_chunk_media(chunks, _TextChunks()))
    assert result[0]["media"][0]["path"] == "img.png"
    assert operate._workspace_has_media.get("ws") is True


def test_hydrate_unknown_without_media_stays_unknown():
    """An unknown workspace whose sample has no media stays unknown (it is
    never concluded media-free from a single query sample)."""
    from lightrag.operate import _hydrate_chunk_media

    operate = _media_flag_workspace()

    class _TextChunks:
        workspace = "ws"

        async def get_by_ids(self, ids):
            return [{"content": "x"} for _ in ids]

    chunks = [{"chunk_id": "c1", "content": "x", "file_path": "f"}]
    result = asyncio.run(_hydrate_chunk_media(chunks, _TextChunks()))
    assert "media" not in result[0]
    assert "ws" not in operate._workspace_has_media


def test_ensure_flag_marks_fresh_workspace_media_free():
    """A fresh (empty) chunks store at first write marks the workspace as
    media-free; a pre-existing store stays unknown."""
    from lightrag.operate import ensure_workspace_has_media_flag

    operate = _media_flag_workspace()

    class _EmptyChunks:
        async def is_empty(self):
            return True

    class _FilledChunks:
        async def is_empty(self):
            return False

    asyncio.run(ensure_workspace_has_media_flag("fresh", _EmptyChunks()))
    assert operate._workspace_has_media.get("fresh") is False

    asyncio.run(ensure_workspace_has_media_flag("existing", _FilledChunks()))
    assert "existing" not in operate._workspace_has_media

    # A workspace already marked media-bearing is left untouched.
    operate._workspace_has_media["media-ws"] = True
    asyncio.run(ensure_workspace_has_media_flag("media-ws", _EmptyChunks()))
    assert operate._workspace_has_media.get("media-ws") is True
