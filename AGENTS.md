# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout — two independent subprojects

`ParrotBuddy` is a workspace container, **not a unified codebase**. It holds two self-contained upstream clones, each with its **own git repository** (own branch, remote, `.venv`, and `CLAUDE.md`/`AGENTS.md`):

- **`LightRAG/`** — [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG): a graph-based Retrieval-Augmented Generation (RAG) framework. Python core + React/TypeScript WebUI (`lightrag_webui/`).
- **`nanobot/`** — [HKUDS/nanobot](https://github.com/HKUDS/nanobot): a lightweight AI agent framework (channels, tools, memory, MCP). Python core + React/TypeScript WebUI (`webui/`).

Read `LightRAG/CLAUDE.md` → `LightRAG/AGENTS.md` and `nanobot/CLAUDE.md` → `nanobot/AGENTS.md` before editing either — those are the authoritative, detailed guides (architecture, pipeline concurrency contract, storage layer, gotchas).

### Implications of the two-repo layout

- **Git operations target the sub-repo, not the parent.** Make commits, branches, and PRs inside `LightRAG/` or `nanobot/` (the parent repo has no commits and only contains the two untracked subdirectories). PRs for LightRAG target upstream `HKUDS/LightRAG` (this is a fork), not a local fork.
- **Each subproject has its own virtualenv.** Activate the venv inside the subproject (`LightRAG/.venv`, `nanobot/.venv`) before running its Python tooling; do not share or install across them.
- **Never interleave the two projects** — they are separate packages with separate configs, test suites, and lockfiles. A change lives entirely in one of them.

## Commands per subproject

### LightRAG (`cd LightRAG`)

```bash
uv sync --extra api --extra offline-storage --extra offline-llm --extra test  # setup
cp env.example .env                 # configure LLM/embedding/storage backends
./scripts/test.sh tests             # preferred backend test runner (pytest wrapper)
./scripts/test.sh tests/kg/test_graph_storage.py   # single test file
ruff check .                        # lint
# WebUI
cd lightrag_webui && bun install --frozen-lockfile
bun run dev                         # dev server
bun test                            # frontend tests (Bun runner, NOT vitest/jest)
bun run build
# Run server
lightrag-server                     # production (after `uv sync --extra api`)
uvicorn lightrag.api.lightrag_server:app --reload   # dev
```

### nanobot (`cd nanobot`)

```bash
uv sync                             # setup
pytest tests/test_openai_api.py::test_function -v   # single test
pytest tests/                       # full suite (asyncio_mode = "auto")
ruff check nanobot/                 # lint (never `ruff format` — destroys git blame)
cd webui && bun run dev             # dev server (proxies to gateway :8765)
cd webui && bun run build           # outputs to ../nanobot/web/dist (bundled into wheel)
cd webui && bun run test            # frontend tests
nanobot gateway                     # run the gateway
```

## Cross-cutting rules

- **Working language for artifacts:** comments, backend code, log messages, and git commit messages are in **English** in both projects (LightRAG enforces this explicitly; commit subjects and bodies too). The WebUI uses i18next for user-facing strings.
- **Backend tests must not depend on live external services** — mock Redis/httpx/etc. Add a regression test for every bug fix.
- **LightRAG critical gotcha:** always call `await rag.initialize_storages()` after constructing a `LightRAG` (missing it manifests as `AttributeError: __aenter__` / `KeyError: 'history_messages'`).
- **LightRAG custom embeddings:** wrap with `@wrap_embedding_func_with_attrs` and call the underlying `.func`, never re-wrap an already-decorated function. When switching embedding models you must clear the data directory (vectors from the old model won't match).
- **nanobot gotchas:** do not run `ruff format` (only `ruff check`); `config.json` `${VAR}` refs are resolved at load time and raise `ValueError` if the env var is missing; `agent/memory.py` writes `history.jsonl` atomically (fsync) — don't replace with a plain write; agent behavior is defined by Jinja2 templates in `nanobot/templates/` as much as by Python code.

## Code style

- Python: PEP 8, 4-space indent, type annotations, async/await throughout, dataclasses for state. LightRAG uses `lightrag.utils.logger` (not `print`).
- TypeScript/React: functional components + hooks, PascalCase components, 2-space indent, single quotes, Tailwind utility-first styling.
- Lint in both projects is `ruff`; line length 100 for nanobot (E501 ignored).
