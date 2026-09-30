# turn-timer

Inspect Claude Code session logs to find where sessions go wrong: **which sessions cost the most**, and **where Claude made serial round-trips it didn't need to**.

turn-timer reads the JSONL transcripts in `~/.claude/projects` and breaks each session down by prompt and turn. It estimates each session's cost from the token usage in the logs, ranks sessions across all projects, and flags streaks of single-call turns that could have been one batched turn.

## Terms

| Term | Meaning |
|---|---|
| **Prompt** | Your message and everything Claude did in response |
| **Turn** | One model response, i.e. one API round-trip |
| **Batch size** | Tool calls in one turn |
| **Batchable run** | 2+ consecutive single-call turns whose calls didn't depend on each other |

Runs are **likely** batchable when every call is read-only (Read, Grep, Glob, WebFetch, read-only shell commands). They are **possibly** batchable when they include edits to different files. A run breaks when a call mentions a path or pattern that appeared in an earlier result within the run, since that call probably needed the result.

## Cost

Every model response in the logs records its token usage: uncached input, cache writes (5-minute and 1-hour), cache reads and output. turn-timer counts each response once and prices it at Anthropic API list prices ([src/core/cost.ts](src/core/cost.ts)). Cache writes cost 1.25× the input rate (5-minute) or 2× (1-hour). Fast mode costs 2×. Web searches cost $10 per 1,000. Subagent usage counts toward the session that spawned it. Turns on a model with no known price are left out of the total and reported separately.

This is an estimate at API rates, not a bill. On a Pro or Max subscription, it still ranks sessions by how much usage they consumed.

In long sessions, **cache reads usually dominate**: every turn re-reads the whole cached context. That's also why an unnecessary round-trip costs money. A batchable run's "cost saved" is the context re-read (uncached input plus cache reads) of each extra turn. A batched turn would still pay for the output and the new cache writes.

## Batching

"Time saved" is each extra turn's round-trip overhead: its latency minus the time spent generating output (13 ms per output token, calibrated from real sessions). A batched turn would still generate the same thinking and tool inputs, so only the overhead is saved.

## Install

Requires Node 22+.

```bash
npm install
npm run build
npm install -g .
```

This works the same on Windows and macOS. For development without installing, use `npm run dev -- <command>`.

## CLI

```bash
turn-timer                                # interactive: pick project → session → expand prompts
turn-timer top                            # most expensive sessions across all projects (last 30 days)
turn-timer top --since 7d -n 10 -p "alien loot"
turn-timer projects
turn-timer sessions "alien loot"          # project by index, folder name or path fragment
turn-timer show 5ec54f26                  # per-prompt table (session id prefix, title fragment)
turn-timer show latest -p "alien loot" --turns   # every turn with its tool calls
turn-timer show 5ec54f26 --prompt 8 -v    # one prompt, with each call's input
turn-timer show 5ec54f26 --by-tool
turn-timer stats "alien loot" --since 7d  # summary across a project's sessions
turn-timer serve                          # web viewer on http://localhost:4317
```

Global flags: `--json`, `--no-subagents`, `--no-cache`, `--config <path>`.

## Web viewer

`turn-timer serve` opens a local viewer (bound to 127.0.0.1):

- **Most expensive sessions** (the landing page): every session across all projects, ranked by estimated cost. It shows each session's peak context, cost per turn, cache-read share and what batching would have saved, plus a total cost breakdown by token kind and model.
- **Project overview:** cost and batching stats across every session, the per-session table (sortable by cost) and the per-tool table.
- **Session view:** summary tiles, the cost breakdown, the batch-size histogram, and one row per prompt with its cost. Expand a prompt to see its turn timeline:
  - batch-size badges and tool chips
  - timing bars (model latency vs tool time)
  - flagged runs highlighted
  - subagents nested under the Agent call that spawned them
- **Batchable runs tab:** every flagged run, sorted by round-trips saved. Click one to jump to it.
- **Detail drawer:** click any tool call to see its full input and result. These are read from the log on demand.

To develop the viewer, run `npm run dev -- serve --no-open` in one terminal and `npm run dev:web` in another.

## Configuration

Classification rules can be tuned in `./turn-timer.config.json` or `~/.turn-timer.json`. Any key replaces the default from [src/core/config.ts](src/core/config.ts):

```json
{
  "readOnlyTools": ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__unity__get_console_logs"],
  "readOnlyCommands": ["ls", "cat", "git status", "unity status"]
}
```

## Notes

- Parsed sessions are cached per session in the OS cache dir (`%LOCALAPPDATA%\turn-timer\cache`, `~/Library/Caches/turn-timer`). A cache entry is invalidated when the log files or the config change. The first parse of a 500 MB session takes about 1.5 s.
- Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30). Raise it in `~/.claude/settings.json` if you want a longer history.
- `CLAUDE_CONFIG_DIR` is respected.
