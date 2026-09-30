# turn-timer — plan

A tool for inspecting Claude Code session logs, focused on **how many tool calls Claude batches into each model round-trip**, and where it makes serial round-trips it didn't need to.

Runs on Windows and macOS. TypeScript on Node 22+. Ships as one npm package with a CLI and a local web viewer.

## Terminology

| Term | Meaning | How it's found in the logs |
|---|---|---|
| **Prompt** | One user message and everything Claude does in response | `promptId` on `user` records |
| **Turn** | One model response, i.e. one API round-trip | records sharing `message.id` (`type: "assistant"`) |
| **Tool call** | One `tool_use` block inside a turn | `message.content[].type === "tool_use"` |
| **Batch size** | Tool calls in one turn | count of the above per `message.id` |

This matches Anthropic's usage (`--max-turns`, `num_turns`), where a turn is one agentic round-trip.

## What the logs look like (verified against real sessions)

- Location: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Respect `CLAUDE_CONFIG_DIR` if it's set.
- The folder name is a lossy encoding (`C:\workspace\Alien Loot` becomes `C--workspace-Alien-Loot`). Display the `cwd` field from the records instead.
- **Each content block is its own line.** One turn with thinking, text and 5 tool calls spans about 7 lines, all sharing the same `message.id`.
- Tool results come back as `user` records with `tool_result` blocks and a `toolUseResult` payload. The payload can be huge, so it's skipped during indexing.
- Subagents live in `<sessionId>/subagents/agent-<id>.jsonl`, next to an `agent-<id>.meta.json` of the form `{ agentType, description, toolUseId, spawnDepth }`. `toolUseId` links the subagent to the parent's Agent tool call. The parent's tool result also has `totalToolUseCount`, `totalDurationMs` and `toolStats`.
- Other record types to handle or ignore: `system` (retries, errors), `attachment`, `queue-operation`, `last-prompt`, `custom-title`, `pr-link`, `mode`, and compact summaries (`isCompactSummary`).
- Files can be **500 MB or more**, so parsing must stream.
- Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30). Mention this in the README.

## Architecture

```
src/
  core/
    paths.ts        find config dir, projects, sessions (cross-platform)
    discover.ts     cheap session listing: stat + read the first ~50 lines for cwd, title, first prompt, start time
    parse.ts        stream JSONL → typed events (readline over createReadStream), recording each line's byte offset
    model.ts        events → Session { prompts[] { turns[] { toolCalls[] } } }, with subagents attached
    classify.ts     tool categories (read-only, write, exec, mcp, agent) and read-only Bash detection
    metrics.ts      per-turn, per-prompt, per-session and per-project stats, plus batchable-run detection
    cache.ts        per-session summary cache keyed by (path, size, mtime) in the OS cache dir
    detail.ts       read one record by byte offset (full tool input and result, loaded on demand)
  cli/              commander + @inquirer/prompts; table output and --json
  server/           tiny HTTP server (node:http) with a JSON API; serves the built viewer
web/                Vite + React viewer, built into dist/web and served by `turn-timer serve`
test/fixtures/      trimmed real JSONL snippets (parallel calls, subagents, interrupts, compaction)
```

Indexing keeps only what the metrics need: IDs, timestamps, tool names, a short input summary, error or denied flags, and byte offsets. Full inputs and results are fetched by offset when the viewer asks for them. That keeps the index for a 569 MB session small, and a second open is instant thanks to the cache.

### Data model (sketch)

```ts
interface Session  { id; projectCwd; title?; startedAt; endedAt; prompts: Prompt[]; stats: Stats }
interface Prompt   { id; index; text; startedAt; endedAt; turns: Turn[]; interrupted: boolean; stats: Stats }
interface Turn     { messageId; index; agent: AgentRef; startedAt; respondedAt; toolCalls: ToolCall[];
                     hasText; hasThinking; model; usage }
interface ToolCall { id; name; category; inputSummary; offset; resultOffset?; isError; denied;
                     startedAt; finishedAt?; subagent?: SubagentRun }
interface SubagentRun { agentId; agentType; description; turns: Turn[]; stats: Stats }
type AgentRef = { kind: "main" } | { kind: "subagent"; agentId; agentType; depth }
```

A subagent's turns are **counted in the parent prompt's totals**, but each carries `agent.kind === "subagent"`. That lets the CLI and viewer split them out, and the viewer nests them under the Agent call that started them.

## Metrics

Per turn: batch size, tools used, model latency (from the previous event to the response), tool time (from `tool_use` to its `tool_result`).

Per prompt, session and project:
- turns, tool calls, and average and median batch size
- batch-size histogram (1, 2, 3, 4–5, 6–10, 11+)
- **share of turns with a single tool call**
- for each tool, how often it's called alone and its average batch size
- **batchable runs** (below), with an estimate of the time they cost
- all of the above split into main thread and subagents

### Batchable-run detection (v1 rules)

A **run** is 2 or more consecutive single-call turns, in the same prompt and the same agent, with no user input between them. A run is flagged as:

- **Likely batchable:** every call is read-only and independent. Read-only covers Read, Grep, Glob, WebFetch and WebSearch, plus Bash or PowerShell matching a read-only allowlist (`git status|log|diff|show`, `ls`, `cat`, `head`, `find`, `rg`, `grep`, `wc`, `Get-ChildItem`, `Get-Content`, …). Tighter still: none of the later call's input text appears in the earlier call's result. That's a cheap heuristic for "it didn't need the result".
- **Possibly batchable:** Edit or Write calls to *different* files, or a mix of reads and edits to different files.
- Anything else is treated as sequential by necessity and not flagged.

Estimated cost of a flagged run = the sum of model latency for every turn after the first. The rules and the allowlist go in a config file (`turn-timer.config.json`) so they can be tuned without code changes.

## CLI

```
turn-timer                              interactive: pick project → pick session → show
turn-timer projects                     list projects (cwd, sessions, last active)
turn-timer sessions [project]           list sessions (title / first prompt, date, size, turns)
turn-timer show <session> [--prompt N]  per-prompt table: turns, calls, avg batch, single%, flagged runs, time
                    [--turns]           expand to one row per turn with its tool list
turn-timer stats [project] [--since 14d] [--by tool|session]
turn-timer serve [--port 4317] [--open] local web viewer
common: --json, --no-subagents, --config <path>
```

Projects and sessions can be referred to by an index from the listing, a name fragment or an ID.

## Web viewer

- **Left:** project list, then that project's sessions (newest first, with the first-prompt preview, size and a small single-call% bar).
- **Session header:** totals, the batch-size histogram, single-call %, and flagged runs with estimated time lost. Toggles for "main thread only" and "show subagents".
- **Prompt list:** one row per prompt with its text preview, turns, calls, average batch and flags. Expand a prompt to see its **turn timeline**:
  - each turn row shows its index, a batch-size badge, tool chips and latency
  - flagged runs are highlighted as a group
  - subagent turns are nested and indented under their Agent call, with a distinct color and an `agentType` label
- **Click a tool call** to open a side panel with the full input and result, fetched by byte offset through `/api/detail`.
- API: `/api/projects`, `/api/projects/:id/sessions`, `/api/sessions/:id`, `/api/sessions/:id/detail?offset=`, `/api/stats`.

## Edge cases to cover in fixtures

Parallel tool calls split across lines · user interrupts (`[Request interrupted by user]`) · denied tool calls (`toolDenialKind`) · tool errors (`is_error`) · API retries (`system` with `retryAttempt`) · compaction (`isCompactSummary`, `logicalParentUuid`) · messages queued mid-prompt (`queue-operation`) · rewinds/branches (v1 follows file order; `parentUuid`-based branch handling comes later) · resumed sessions · nested subagents (`spawnDepth` > 1) · a truncated last line (session still being written).

## Milestones

Status (2026-09-29): 1–4 done, plus cost estimates (6). Remaining: test on macOS, packaging polish.

1. **Core:** paths, discover, stream parse and model, with vitest tests on the fixtures. Check against the prototype numbers (Alien Loot main thread: about 53% single-call turns).
2. **CLI:** `projects`, `sessions`, `show`, and the interactive picker.
3. **Metrics:** batchable-run detection, `stats` across a project, and the summary cache.
4. **Viewer:** server, API and the React viewer with drill-down and the detail panel.
5. **Polish:** a test run on macOS, README, `npm i -g` packaging, and tuning the config file.
6. **Cost:** per-turn token usage and estimated cost at API list prices (`core/cost.ts`), `turn-timer top` and the viewer landing page ranking sessions across all projects by cost, and the cost of batchable runs.

Direction (2026-09-29): the project is broadening from batching alone to finding Claude Code issues in general. Cost is the entry point for picking which sessions to dig into.

## Later ideas

Compare sessions or time periods (did a CLAUDE.md change improve batching?), per-model comparisons, other issue detectors (context bloat, retry loops, repeated failing commands, compaction churn), a live "tail" mode for the current session, and export of flagged runs as examples for prompt tuning.
