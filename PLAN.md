# Claude Session Viewer — plan

A tool for finding where Claude Code sessions go wrong: **what they cost, where the time went, which tool calls were slow, and what cache misses added**. Cost is the entry point for picking which sessions to dig into.

Runs on Windows and macOS. TypeScript on Node 22+. One npm package: a CLI (`claude-sessions`) that parses the logs and writes a static HTML report.

History: the project started as `turn-timer`, which measured how many tool calls Claude batched per round-trip. On 2026-09-29 it moved to cost, time and cache misses; the batching metrics, the server and the interactive CLI were removed.

## What the logs look like (verified against real sessions)

- Location: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. `CLAUDE_CONFIG_DIR` is respected.
- The folder name is a lossy encoding (`C:\workspace\Alien Loot` becomes `C--workspace-Alien-Loot`). Display the `cwd` field from the records instead.
- **Each content block is its own line.** One turn spans several lines sharing a `message.id`, and each repeats the usage, so usage is taken as the max per field.
- Subagents live in `<sessionId>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` (`{ agentType, description, toolUseId, spawnDepth }`). `toolUseId` links a run to the Agent call that started it. Runs without one, and `isSidechain` records in the main file, are still counted and shown under their prompt.
- Each turn's usage names one cache TTL (5-minute or 1-hour writes). It can differ between the main thread and subagents.
- Files can be 500 MB or more, so parsing streams.

## Architecture

```
src/core/
  paths.ts, discover.ts   find projects and sessions; cheap listing from the first lines of each log
  lines.ts, records.ts    stream JSONL; typed record helpers
  parse.ts                records → Session { prompts[] { turns[] { calls[] } } }, subagents attached
  classify.ts             tool categories, input previews
  cost.ts                 pricing and per-turn cost
  metrics.ts              time, cost by model, per-tool stats, slowest calls, cache-miss detection
  report-data.ts          the index row per session and the embedded data format
src/cli/index.ts          build the report: parse (4 at a time), embed the index and every session in one HTML file
web/                      Vite + React page, built into one inlined dist/report/shell.html
```

The page embeds the index (one row per session) and each session's data as JSON script elements, parsed when a session is opened. It works from `file://`.

Privacy: the report HTML in the current folder is the only file written. No cache or temp files, console output never quotes the logs, and tool output never enters the report (only its size).

## Cache-miss detection

Per stream (the main thread across prompts, or one subagent run), compare each turn with the previous one. With `expected` = the previous turn's context, `lost = expected − cacheRead` and `rewritten = input + cache writes`, a turn is a miss when `lost ≥ 5,000`, `cacheRead < 0.8 × expected`, and `rewritten ≥ 0.5 × lost` (which excludes compaction). The kind is *model switch* if the model changed, *expired* if the gap exceeded the stream's TTL, otherwise *cache reset*. Its extra cost is `min(lost, rewritten)` priced at the write rate minus the read rate.

## Status

Done: parser, cost, time, cache misses, static report, tests. Remaining: test on macOS, compare costs against Anthropic's usage data for one session.

## Later ideas

Compare time periods (did a CLAUDE.md change help?), other issue detectors (context bloat, retry loops, repeated failing commands, compaction churn), and per-project cost trends.
