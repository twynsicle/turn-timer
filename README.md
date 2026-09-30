# Claude Session Viewer

An HTML report of your Claude Code sessions: **what they cost, where the time went, which tool calls were slow, and how much cache misses added**.

`claude-sessions` reads the JSONL transcripts in `~/.claude/projects` and writes a static report you open in a browser. No server needs to stay running. It takes a few seconds, and parsed sessions are cached, so later runs are faster.

## Install

Requires Node 22+.

```bash
npm install
npm run build
npm install -g .
```

This works the same on Windows and macOS.

## Usage

```bash
claude-sessions                       # last 30 days, all projects; opens the report
claude-sessions --since 7             # last 7 days (0 = everything still on disk)
claude-sessions -p "alien loot"       # only projects whose path contains this text
claude-sessions -o ./report --no-open # write somewhere else, don't open a browser
claude-sessions --no-cache            # re-parse every log
```

By default the report goes to `report/` in the cache folder (`%LOCALAPPDATA%\claude-session-viewer\cache\report`, `~/Library/Caches/claude-session-viewer/report`). The folder is self-contained: `index.html` plus one `sessions/<id>.js` per session, loaded when you open that session.

## The report

- **Projects:** total cost split by model, time working, turns, cache misses and a cost-per-day chart (stacked by model, local time), then one row per project with the same rollups and the date range its sessions cover. Worktree sessions count toward their project. Sort by cost, time, turns, cache misses or recency.
- **Project page:** the same summary for one project and one row per session.
- **Slowest tool calls** and **Tools** (calls, errors, total and average time per tool), on both pages.
- **Session page:** the same summary for one session, then one row per prompt. Expand a prompt to see its full text and every turn, with its model, tool calls, model time and cost. Subagents are nested under the Agent call that started them. A turn that had to rebuild the cache is marked with a row just before it. Click a tool call to see its input and result preview.

## Terms

| Term | Meaning |
|---|---|
| **Prompt** | Your message and everything Claude did in response |
| **Turn** | One model response, i.e. one API round-trip |
| **Model time** | Time waiting on the model (main thread only) |
| **Tool time** | Time from a tool call to its result (main thread only) |
| **Waiting on you** | Time AskUserQuestion and plan approvals (ExitPlanMode) sat open until you answered. Left out of tool time, time working, the Tools table and the slowest calls |
| **Time working** | Time from each prompt to its last activity, summed, minus time waiting on you. Idle time between prompts isn't counted |

A session is named by its title if it has one, otherwise by its first meaningful prompt: the first thing you typed or a command that asks for work. Empty prompts, notifications and housekeeping commands like `/clear`, `/login` or `/model` are skipped.

## Cost

Every model response in the logs records its token usage: uncached input, cache writes (5-minute and 1-hour), cache reads and output. Each response is counted once and priced at Anthropic API list prices ([src/core/cost.ts](src/core/cost.ts)):

| Model | Input | Output | Cache read |
|---|---|---|---|
| Fable 5.1 | $10 | $50 | $0.25 |
| Opus 5.5 | $4 | $20 | $0.20 (0.05× input) |
| Sonnet 5.5 | $2 | $10 | $0.20 (0.1× input) |
| Opus 5 | $5 | $25 | $0.50 |

Prices are per million tokens; see the file for the full table. Cache writes cost 1.25× the input rate (5-minute) or 2× (1-hour). Fast mode costs 2×. Web searches cost $10 per 1,000. Subagent usage counts toward the session that spawned it. Turns on a model with no known price are left out of the total and flagged.

This is an estimate at API rates, not a bill. It only sees what's in the transcripts. Background calls Claude Code makes outside the conversation (titles, compaction summaries, permission classifiers) don't appear there, so a bill or the Admin usage API can come out higher.

## Cache misses

Each turn re-sends the whole conversation, and normally almost all of it is a cheap cache read. A **cache miss** is a turn where a large part of the context (5,000+ tokens) that the previous turn had cached was written again instead of read. The report classifies each one:

- **Cache expired:** the gap since the previous turn was longer than the cache lifetime. Claude Code writes either a 5-minute or a 1-hour cache, and the lifetime is read from the logs per thread.
- **Model switch:** the turn used a different model, which has its own cache.
- **Cache reset:** anything else that changed the start of the context, such as a changed system prompt or tool list.

Compaction isn't counted: it shrinks the context rather than rewriting it. The **extra cost** of a miss is what rewriting the lost tokens cost, minus what reading them from cache would have cost.

## Development

```bash
npm run dev -- --since 0 --out .dev-report --no-open   # CLI from source (needs `npm run build` once for the page)
npm run dev:web                                        # page with hot reload, reading .dev-report
npm test
```

## Notes

- Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30). Raise it in `~/.claude/settings.json` for a longer history.
- `CLAUDE_CONFIG_DIR` is respected. `CLAUDE_SESSIONS_CACHE_DIR` overrides the cache folder.
- Logs can be 500 MB or more. They're streamed, and the tool input and result previews in the report are capped (shorter in very busy sessions) to keep each session's file loadable.
