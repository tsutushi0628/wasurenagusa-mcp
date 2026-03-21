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
3. **Converts negatives to positives** — Generates `positiveRule` alongside each principle: "don't do X" becomes "do Y instead." Research shows LLMs follow affirmative instructions significantly better than prohibitions ([Pink Elephant problem](https://arxiv.org/abs/2404.15154))
4. **Compresses config into themes** — LLM groups scattered settings into coherent summaries, preserving facts like ports and paths
5. **Injects only what matters** — Consolidated wisdom + active settings only. No template bloat, no duplicate entries.
6. **Semantic memory with vector search** — Gemini embeddings power meaning-based retrieval across short/medium/long-term memory tiers. Frequently accessed memories auto-promote to highest intensity.

**Fully automated via Claude Code hooks — zero configuration after setup.**

### Real-world impact

From the author's daily use across 8 production projects (with cross-project memory sharing between them):

```
1,581 "dont" entries   →  5-9 principles per project    (LLM consolidation)
  each with positiveRule  →  affirmative-only injection  (Pink Elephant fix)
29 config entries      →  4-5 thematic summaries        (LLM consolidation)
21,800 chars raw data  →  6,200 chars injected           (71% reduction)
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
| Auto-promotion (intensity) | Yes (access count → intensity 5) | No | No | No |
| Zero-effort via hooks | Yes | Yes | No | No |
| Human-readable storage | Yes (Markdown + JSON vectors) | No (SQLite) | No (ChromaDB) | Yes |
| Multi-LLM support | Gemini / OpenAI / Anthropic | Claude only | Local embeddings | N/A |
| Token-efficient retrieval | Yes (index → detail, 70-90% savings) | Yes (3-layer) | N/A | No |
| Cross-project memory | Yes (top 5 active projects) | No | No | No |
| License | MIT | AGPL-3.0 | Apache-2.0 | N/A |

---

## How It Works

```
Session Start (Hook) — injection mode
  → Checks if consolidation is stale
  → Spawns background LLM worker if needed (non-blocking)
  → Spawns background embedding backfill worker (non-blocking)
  → Injects consolidated config + principles (layer 1) + recent 30-day entries (layer 2) + owner profile
  → Vector search injects semantically related short-term memories (layer 3)
  → Cross-project vector search injects related memories from other active projects (layer 4)
  → Only customized settings injected (defaults stripped)

Session Start (Hook) — agent mode
  → Injects dont summary + config index + owner profile (minimal footprint)
  → No vector search at startup (deferred to on-demand recall)

User Prompt (Hook) — agent mode
  → Injects 1-line reminder: "search memory if relevant"
  → Main agent spawns memory-recall sub-agent as needed
  → Sub-agent runs memory_search → returns summary only (no raw data in main context)
  → Survives compaction (re-injected on every user message)

During Session
  → memory_save auto-generates 768-dim embedding via Gemini
  → memory_search merges keyword + vector semantic results
  → Vector hits increment access counts → auto-promote to intensity 5 at threshold

Session End (Hook)
  → LLM analyzes the conversation
  → Detects mistakes, frustration, retry patterns
  → Auto-saves lessons learned (with embedding)
  → Deduplicates against existing entries before saving
  → Updates active projects tracker (top 5 recent projects)

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
    "UserPromptSubmit": [
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
| `memory_search` | Lightweight index search (ID, title, tags only). Use `project: "active"` for cross-project search |
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
| `wasurenagusa-context` | Output config + dont + vector memories to stdout | SessionStart / UserPromptSubmit / PreCompact Hook |
| `wasurenagusa-analyze` | LLM-analyze conversation and auto-save | Stop Hook |
| `wasurenagusa-backfill` | Generate embeddings for entries without vectors | Background (auto-spawned) |
| `wasurenagusa-rebuild` | Repair corrupted memory data (dedup, re-sort logs) | Manual |
| `wasurenagusa-spec-update` | Auto-update spec documents | cron / systemd timer |
| `wasurenagusa-consolidate-all` | Run consolidation across all active projects | Manual / Scheduler |
| `wasurenagusa-scheduler` | Install/uninstall/status nightly consolidation scheduler | Manual |

---

## Output Mode

wasurenagusa supports two output modes for the SessionStart Hook, configurable per project via `.wasurenagusa/config.json`.

| Mode | Description | Best for |
|------|-------------|----------|
| **injection** (default) | Injects full memory text at session start | Environments without sub-agents (Cursor, Windsurf, etc.) |
| **agent** | Injects minimal index at session start + memory-recall reminder on each user message. Details retrieved on-demand via sub-agents | Claude Code + Agent Teams |

### Configuration

Add `outputMode` to your project's `.wasurenagusa/config.json`:

```json
{
  "outputMode": "agent"
}
```

If the file doesn't exist or `outputMode` is not set, the default is `"injection"` (full backward compatibility).

### Recommended CLAUDE.md rules for agent mode

When using `"agent"` mode with Claude Code Agent Teams, add these rules to your project's `CLAUDE.md`:

```markdown
- Read/write memories via sub-agents (memory_search / memory_get_detail / memory_save)
- Do not bring raw memory data into the main context
- When system-reminder suggests memory recall, spawn a sub-agent to run memory_search and return summary only
```

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

**Automatic promotion:** Every time a memory is retrieved via vector search, its access count increments. After 5 retrievals, the memory auto-promotes to `intensity: 5` — ensuring frequently-needed knowledge gets maximum weight in consolidation. Long-dormant memories can be "woken up" by relevance and eventually earn top intensity through repeated access.

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

### Cross-Project Memory

wasurenagusa automatically tracks your top 5 most recently used projects and searches across their memories for relevant context.

**How it works:**

1. **Stop Hook** records each project session in `~/.wasurenagusa/scheduler/active-projects.json`
2. **SessionStart** searches other active projects' vector stores (short tier ≤ 0.2, high-relevance only)
3. **`memory_search`** with `project: "active"` searches across all active projects (keyword + vector)

**Example:** You're working on `project-a` and previously discussed authentication in `project-b`. When you start a session in `project-a` and the topic is related, wasurenagusa automatically surfaces the relevant auth memories from `project-b`.

No configuration needed — works automatically after two or more projects have been used.

### LLM Consolidation

When memory entries accumulate, the LLM automatically compresses them into compact summaries:

- **Dont entries** → 5-9 behavioral principles scored by `sourceCount × maxIntensity`. Each principle includes both the original `rule` (❌→💡→✅ format) and a `positiveRule` (affirmative-only phrasing). The `positiveRule` is injected by default — research on the [Pink Elephant problem](https://arxiv.org/abs/2404.15154) shows LLMs struggle with negation in instructions.
- **Config entries** → 4-5 thematic summaries (e.g., 29 entries → 5 themes preserving all ports, paths, URLs)

Consolidation runs as a detached background process during session start, and optionally as a **nightly scheduled job** (2:00 AM). Results are cached as JSON and used from the next session onward. Staleness is detected by comparing file modification times and entry counts.

Raw entries are always preserved. The consolidated version is injected at session start; original entries remain searchable via `memory_search`.

#### Positive Rule Conversion

Every consolidated principle stores two forms:

| Field | Format | Purpose |
|-------|--------|---------|
| `rule` | ❌ Bad pattern → 💡 Why it's bad → ✅ Correct behavior | Full context for `memory_get_detail` |
| `positiveRule` | Affirmative-only action statement ("do X", "use Y") | Injected into LLM context |

**Why?** LLM attention mechanisms activate concepts mentioned in negations — "don't use innerHTML" still activates "innerHTML." Affirmative instructions ("use textContent") activate only the desired behavior. The raw user feedback (`dont.md`) is preserved unchanged; conversion happens only at the consolidation layer.

#### Memory Intensity (1-5)

Every dont entry carries an **intensity** score (1-5) representing the severity of the lesson:

| Intensity | Meaning | Example |
|-----------|---------|---------|
| 5 | Rage / resignation — user nearly gave up | "I told you 10 times, STOP doing this" |
| 4 | Strong frustration — explicit anger | "No! Don't do that!" |
| 3 | Clear correction — firm but calm | "That's wrong, do it this way" |
| 2 | Mild note — gentle guidance | "Next time, prefer X over Y" |
| 1 | Suggestion — informational | "FYI, we usually do it like this" |

**Auto-detection:** The LLM analyzes user messages for emotional signals (exclamation marks, strong language, repeated corrections) and assigns intensity automatically. Conversation metadata (turns since last positive feedback, message length ratio) provides additional boost signals.

**Manual override:** Pass `intensity: N` to `memory_save` to set or adjust the score.

**Scoring formula:** During consolidation, each principle gets `score = sourceCount × maxIntensity`. Principles are sorted by score descending — frequently repeated, high-anger lessons appear first with stronger wording.

### Auto-Archiving

Each memory category has an entry limit (default: 100). When exceeded, oldest entries are automatically moved to archive files (`*-archive.md`). Logs have separate 30-day rotation. Your data is never deleted — just moved out of the active search path.

### Sentiment Detection

Detects user frustration through text patterns, message length changes, and absence of positive signals. Records what went wrong, why, and what to do instead.

### Autonomous Tasks

Submit tasks via `task_submit` and wasurenagusa runs them using Claude CLI as a subprocess. The LLM evaluates completion conditions and retries if needed. Useful for spec updates, refactoring, and test generation.

### Owner Profile

On first run, an `owner-profile.md` template is generated. Fill it in to teach the AI your decision-making preferences for autonomous task execution.

Only sections you've actually customized are injected — default selections and empty fields are automatically stripped, keeping injection minimal.

### Nightly Consolidation Scheduler

Instead of only consolidating at session start, you can schedule nightly consolidation across all active projects — like "sleeping on it overnight."

```bash
# Install (macOS: launchd, Linux: crontab)
wasurenagusa-scheduler install

# Check status
wasurenagusa-scheduler status

# Remove
wasurenagusa-scheduler uninstall
```

Runs daily at **2:00 AM**, consolidating dont and config entries for all recently active projects. This ensures your AI starts every morning with freshly organized principles, even if you never close your sessions.

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
