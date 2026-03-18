# wasurenagusa

**Teach your AI coding agent to learn from its mistakes.**

[![npm version](https://img.shields.io/npm/v/wasurenagusa-mcp)](https://www.npmjs.com/package/wasurenagusa-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

> *wasurenagusa* (forget-me-not) — a Japanese flower whose name means "don't forget me."

---

## The Problem

AI coding agents are powerful but amnesiac. Every session starts from scratch — your project conventions, past decisions, and hard-learned lessons vanish the moment a session ends.

Existing solutions either require manual effort or simply store raw memories that grow until they overwhelm the context window.

## The Solution

wasurenagusa is an MCP server that doesn't just *remember* — it **learns**.

1. **Detects mistakes automatically** — Catches retry patterns, user frustration, and repeated failures
2. **Distills lessons into principles** — LLM compresses hundreds of raw entries into a handful of actionable rules
3. **Compresses config into themes** — LLM groups scattered settings into coherent summaries, preserving facts like ports and paths
4. **Injects only what matters** — Consolidated wisdom + active settings only. No template bloat, no duplicate entries.
5. **Semantic memory with vector search** — Gemini embeddings power meaning-based retrieval across short/medium/long-term memory tiers. Frequently accessed memories auto-promote to critical.

**Fully automated via Claude Code hooks — zero configuration after setup.**

### Real-world impact

From the author's daily use across 8 production projects:

```
1,581 "dont" entries   →  5-9 principles per project (LLM consolidation)
29 config entries      →  4-5 thematic summaries     (LLM consolidation)
21,800 chars raw data  →  6,200 chars injected        (71% reduction)
```

---

## Demo

<!-- TODO: Record a 30-second GIF showing the mistake-detection-and-learning loop -->

<!-- ![wasurenagusa demo](./docs/demo.gif) -->

<details>
<summary>What happens behind the scenes</summary>

1. **Session 1**: Claude uses port 3000 — user corrects it to 8080
2. **Stop Hook**: wasurenagusa auto-analyzes the conversation and records the mistake
3. **Session 2**: Claude correctly uses port 8080 without being told

</details>

---

## Why wasurenagusa

Most memory tools store what happened. wasurenagusa teaches your AI **why things went wrong** — and ensures it never repeats the same mistake.

It's not a memory bank. It's a **learning system**.

| | wasurenagusa | claude-mem | mcp-memory-service | CLAUDE.md |
|---|---|---|---|---|
| Auto-detect mistakes | Yes (retry + sentiment) | No | No | No |
| Auto-consolidate (LLM) | Yes (dont→principles, config→themes) | No | Yes (decay-based) | No |
| Vector semantic search | Yes (Gemini embeddings, 768-dim) | No | Yes (ChromaDB) | No |
| Memory tiers (short/mid/long) | Yes (cosine distance thresholds) | No | No | No |
| Auto-promotion to critical | Yes (access count-based) | No | No | No |
| Zero-effort via hooks | Yes | Yes | No | No |
| Human-readable storage | Yes (Markdown + JSON vectors) | No (SQLite) | No (ChromaDB) | Yes |
| Multi-LLM support | Gemini / OpenAI / Anthropic | Claude only | Local embeddings | N/A |
| Token-efficient retrieval | Yes (index → detail, 70-90% savings) | Yes (3-layer) | N/A | No |
| License | MIT | AGPL-3.0 | Apache-2.0 | N/A |

---

## How It Works

```
Session Start (Hook)
  → Checks if consolidation is stale
  → Spawns background LLM worker if needed (non-blocking)
  → Spawns background embedding backfill worker (non-blocking)
  → Injects consolidated config + principles (layer 1) + critical permanent entries (layer 2) + recent 30-day entries (layer 3) + owner profile
  → Vector search injects semantically related short-term memories (layer 4)
  → Only customized settings injected (defaults stripped)

During Session
  → memory_save auto-generates 768-dim embedding via Gemini
  → memory_search merges keyword + vector semantic results
  → Vector hits increment access counts → auto-promote to critical at threshold

Session End (Hook)
  → LLM analyzes the conversation
  → Detects mistakes, frustration, retry patterns
  → Auto-saves lessons learned (with embedding)
  → Deduplicates against existing entries before saving

Background (async workers)
  → Consolidates "dont" entries → behavioral principles
  → Consolidates "config" entries → thematic summaries
  → Backfills embeddings for entries created before vector layer (20/run)
  → Results used in next session start
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- Claude Code (CLI)
- API key for one of: [Gemini](https://aistudio.google.com/) / [OpenAI](https://platform.openai.com/) / [Anthropic](https://console.anthropic.com/)

### 1. Install

```bash
npm install -g wasurenagusa-mcp
```

Or from source:

```bash
git clone https://github.com/tsutushi0628/wasurenagusa-mcp.git
cd wasurenagusa-mcp
npm install && npm run build
npm link
```

> `npm run build` automatically runs `chmod +x` on CLI entry points. No manual permission setup needed.

### 2. Configure

Create `~/.wasurenagusa/.env`:

```bash
# Set at least one API key
GEMINI_API_KEY=your-key-here
# OPENAI_API_KEY=your-key-here
# ANTHROPIC_API_KEY=your-key-here
```

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | One of three | Google Gemini API key |
| `OPENAI_API_KEY` | One of three | OpenAI API key |
| `ANTHROPIC_API_KEY` | One of three | Anthropic API key |
| `LLM_PROVIDER` | No | `gemini` (default), `openai`, or `anthropic` |
| `LLM_MODEL` | No | Override the default model for your provider |
| `MEMORY_DIR` | No | Memory directory (default: `.wasurenagusa`) |
| `MAX_ENTRIES_PER_CATEGORY` | No | Entry limit per category before auto-archiving (default: `100`) |
| `LOG_RETENTION_DAYS` | No | Log retention period in days (default: `30`) |
| `SLACK_WEBHOOK_URL` | No | Slack notifications for autonomous tasks |

### 3. Register MCP Server

```bash
claude mcp add wasurenagusa -- wasurenagusa-mcp
```

### 4. Set Up Hooks

> **⚠️ Required** — Without this step, memory is never injected at session start. This is the most commonly missed setup step.

Add to `~/.claude/settings.json` (or `settings.local.json` if you prefer to keep hooks separate):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wasurenagusa-context",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wasurenagusa-analyze",
            "timeout": 30
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "wasurenagusa-context",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### 5. Start Using

Launch Claude Code. That's it.

- First session: `.wasurenagusa/` directory is created automatically
- After first conversation: Stop Hook analyzes and saves important context
- Second session onward: accumulated wisdom is auto-injected at start

> Add `.wasurenagusa/` to your `.gitignore` — it contains project-specific memory data.

---

## Memory Categories

| Category | What it stores | File |
|----------|---------------|------|
| **config** | API URLs, ports, auth locations | `config.md` |
| **dont** | Mistakes, anti-patterns, user frustrations | `dont.md` |
| **decision** | Architecture decisions, tech choices | `decisions.md` |
| **log** | Implementation records, resolved errors | `logs/YYYY-MM-DD.md` |
| **snippet** | Frequently used commands & queries | `snippets.md` |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_get_context` | Get config + consolidated principles (auto-called at session start) |
| `memory_search` | Lightweight index search (ID, title, tags only) |
| `memory_get_detail` | Get full detail by ID(s) |
| `memory_save` | Save a memory entry explicitly |
| `memory_delete` | Delete entries by ID |
| `task_submit` | Submit an autonomous task for 24/7 execution |
| `task_status` | Check task execution status |
| `task_action_list` | List and manage pending human actions |
| `project_init` | Initialize project quality standards |

---

## CLI Commands

| Command | Purpose | Invoked by |
|---------|---------|------------|
| `wasurenagusa-context` | Output config + dont + vector memories to stdout | SessionStart Hook / PreCompact Hook |
| `wasurenagusa-analyze` | LLM-analyze conversation and auto-save | Stop Hook |
| `wasurenagusa-backfill` | Generate embeddings for entries without vectors | Background (auto-spawned) |
| `wasurenagusa-rebuild` | Repair corrupted memory data (dedup, re-sort logs) | Manual |
| `wasurenagusa-spec-update` | Auto-update spec documents | cron / systemd timer |

---

## Advanced Features

### Vector Memory Tiers

wasurenagusa introduces a biologically-inspired memory system powered by Gemini embeddings. Every memory is converted to a 768-dimensional vector, enabling meaning-based retrieval that goes far beyond keyword matching.

**Three-tier architecture with cosine distance thresholds:**

| Tier | Threshold | Use case |
|------|-----------|----------|
| **Short-term** | ≤ 0.2 | Highly relevant — auto-injected at session start |
| **Medium-term** | ≤ 0.45 | Contextually related — surfaced during `memory_search` |
| **Long-term** | ≤ 0.7 | Loosely related — discoverable but not proactively shown |

**Automatic promotion:** Every time a memory is retrieved via vector search, its access count increments. After 5 retrievals, the memory auto-promotes to `importance: "critical"` — ensuring frequently-needed knowledge is permanently injected every session. Long-dormant memories can be "woken up" by relevance and eventually earn critical status through repeated access.

**How it works:**

```
memory_save
  → Text → Gemini gemini-embedding-001 → 768-dim vector → vectors.json

memory_search "authentication setup"
  → Keyword search (existing)           ─┐
  → Embed query → cosine distance search ─┤→ merge, deduplicate → results
                                           └→ increment access count
                                              → auto-promote if threshold met

SessionStart Hook
  → Embed project name → short-tier search → inject related memories
  → Spawn backfill worker (20 entries/run, non-blocking)
```

**Zero new dependencies** — uses the existing `@google/generative-ai` package. Vectors are stored locally in `vectors.json` (brute-force search, ~6MB per 1,000 entries). No external database required.

**Graceful degradation** — without a Gemini API key, everything works exactly as before (keyword search only). Vector features activate automatically when `GEMINI_API_KEY` is set.

### LLM Consolidation

When memory entries accumulate, the LLM automatically compresses them into compact summaries:

- **Dont entries** → 5-9 behavioral principles (e.g., 1,581 raw entries → 7 principles). Entries marked `importance: "critical"` are **excluded from consolidation** and preserved as-is permanently.
- **Config entries** → 4-5 thematic summaries (e.g., 29 entries → 5 themes preserving all ports, paths, URLs)

Consolidation runs as a detached background process during session start — no latency impact. Results are cached as JSON and used from the next session onward. Staleness is detected by comparing file modification times and entry counts.

Raw entries are always preserved. The consolidated version is injected at session start; original entries remain searchable via `memory_search`.

#### Memory Strength (importance)

Dont entries support two importance levels:

| importance | Meaning | Consolidation | Injection |
|-----------|---------|--------------|-----------|
| `critical` | Strong prohibitions, peak anger, repeated issues | **Excluded (permanent)** | Injected verbatim every session |
| `normal` | Standard learning records | Consolidated | Injected as principles |

Set manually via `memory_save`. Auto-saved entries are judged by the LLM based on emotional intensity and expression strength.

### Auto-Archiving

Each memory category has an entry limit (default: 100). When exceeded, oldest entries are automatically moved to archive files (`*-archive.md`). Logs have separate 30-day rotation. Your data is never deleted — just moved out of the active search path.

### Sentiment Detection

Detects user frustration through text patterns, message length changes, and absence of positive signals. Records what went wrong, why, and what to do instead.

### Autonomous Tasks

Submit tasks via `task_submit` and wasurenagusa runs them using Claude CLI as a subprocess. The LLM evaluates completion conditions and retries if needed. Useful for spec updates, refactoring, and test generation.

### Owner Profile

On first run, an `owner-profile.md` template is generated. Fill it in to teach the AI your decision-making preferences for autonomous task execution.

Only sections you've actually customized are injected — default selections and empty fields are automatically stripped, keeping injection minimal.

---

## Current Limitations

- **Claude Code only** — Hook-based auto-injection requires Claude Code. The MCP server itself works with any MCP-compatible client, but without auto-injection.

---

## Design Philosophy

- **Autonomous by default, manual by choice** — Hooks automate everything. Manual tools exist but are optional.
- **Context-efficient** — LLM consolidation + smart filtering achieves 71% injection reduction. Two-stage retrieval (index then detail) further reduces on-demand consumption.
- **Human-readable storage** — All memory stored as Markdown. No database, no vendor lock-in.
- **Externalized prompts** — LLM prompts live in `prompts/` as plain text. Iterate without rebuilding.

---

## Development

```bash
npm run build        # Compile TypeScript
npm test             # Run tests
npm run test:watch   # Watch mode
```

---

## License

MIT

---

[Japanese README (日本語)](./README.ja.md)
