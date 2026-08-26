# nanobot Skills

This directory contains built-in skills that extend nanobot's capabilities.

## Skill Format

Each skill is a directory containing a `SKILL.md` file with:
- YAML frontmatter (name, description, metadata)
- Markdown instructions for the agent

When skills reference large local documentation or logs, prefer nanobot's built-in
`grep` tool to narrow the search space before loading full files.
Use `grep(output_mode="count")` / `files_with_matches` for broad searches first,
use `head_limit` / `offset` to page through large result sets,
and `grep(glob="*.md")` to filter by file name pattern.

## Attribution

These skills are adapted from [OpenClaw](https://github.com/openclaw/openclaw)'s skill system.
The skill format and metadata structure follow OpenClaw's conventions to maintain compatibility.

## Available Skills

| Skill | Description |
|-------|-------------|
| `docx` | Create, edit, and analyze Word documents (`.docx`) |
| `pptx` | Create, edit, and analyze PowerPoint presentations (`.pptx`) |
| `doc-coauthoring` | Structured workflow for co-authoring long documents, specs, and proposals |
| `extract-wisdom` | Extract insights, actionable takeaways, and structured summaries from articles, videos, and documents |
| `internal-comms` | Write internal communications (status reports, newsletters, FAQs, 3P updates) |
| `deep-research` | Multi-source deep research with citation tracking, claim verification, and report generation |
| `travel-planner` | Plan trips, generate day-by-day itineraries, budgets, packing lists, and cultural guides |
| `github` | Interact with GitHub using the `gh` CLI |
| `weather` | Get weather info using wttr.in and Open-Meteo |
| `summarize` | Summarize URLs, files, and YouTube videos |
| `cron` | Schedule reminders and recurring tasks |
| `tmux` | Remote-control tmux sessions |
| `clawhub` | Search and install skills from ClawHub registry |
| `skill-creator` | Create new skills |
