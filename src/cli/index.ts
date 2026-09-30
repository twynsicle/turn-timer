#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { loadSession } from "../core/cache.js";
import type { Config } from "../core/config.js";
import { formatTokens, formatUsd } from "../core/cost.js";
import { listAllSessions, listProjects, listSessions } from "../core/discover.js";
import { loadConfig } from "../core/load-config.js";
import {
  type BatchableRun,
  type MetricOptions,
  type Stats,
  pct,
  formatMs,
  mergeStats,
  promptStats,
  sessionStats,
  turnModelMs,
  turnToolMs,
} from "../core/metrics.js";
import { resolveProject, resolveSession } from "../core/resolve.js";
import type { Prompt, Session, SessionInfo, Turn } from "../core/types.js";
import { costLine, date, histogram, modelTable, singlePct, size, summary, table, truncate } from "./format.js";

interface GlobalOpts {
  json?: boolean;
  subagents?: boolean;
  config?: string;
  cache?: boolean;
}

const program = new Command()
  .name("turn-timer")
  .description("Inspect Claude Code session logs: cost, tool calls per turn and missed batching")
  .option("--json", "output JSON")
  .option("--no-subagents", "exclude subagent turns from metrics")
  .option("--config <path>", "config file (default ./turn-timer.config.json or ~/.turn-timer.json)")
  .option("--no-cache", "re-parse sessions instead of using the cache");

const globals = () => program.opts<GlobalOpts>();
const metricOpts = (): MetricOptions => ({ subagents: globals().subagents !== false });
let configPromise: Promise<Config> | undefined;
const config = () => (configPromise ??= loadConfig(globals().config));
const load = async (info: SessionInfo) => loadSession(info.path, await config(), { noCache: globals().cache === false });
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

program
  .command("projects")
  .description("list projects with Claude Code sessions")
  .action(async () => {
    const projects = await listProjects();
    if (globals().json) return out(projects);
    console.log(
      table(
        [{ header: "#", align: "right" }, { header: "project", flex: true }, { header: "sessions", align: "right" }, { header: "last active" }],
        projects.map((p, i) => [String(i + 1), p.cwd, String(p.sessionCount), date(p.lastActive)]),
      ),
    );
  });

program
  .command("sessions [project]")
  .description("list sessions in a project (newest first)")
  .action(async (projectRef?: string) => {
    const project = projectRef ? await resolveProject(projectRef) : await pickProject();
    const sessions = await listSessions(project.dir);
    if (globals().json) return out(sessions);
    console.log(pc.bold(project.cwd));
    console.log(sessionTable(sessions));
  });

program
  .command("show [session]")
  .description("per-prompt batching breakdown for a session (id prefix, title fragment, index or 'latest')")
  .option("-p, --project <project>", "project to look in")
  .option("-t, --turns", "list every turn with its tool calls")
  .option("-v, --verbose", "with --turns, list each tool call's input")
  .option("--prompt <n>", "only this prompt (1-based), implies --turns")
  .option("--by-tool", "per-tool breakdown")
  .action(async (ref: string | undefined, o: { project?: string; turns?: boolean; verbose?: boolean; prompt?: string; byTool?: boolean }) => {
    const info = ref ? await resolveSession(ref, o.project) : await pickSession(o.project);
    const session = await withSpinner(`Parsing ${size(info.size)}`, () => load(info));
    if (globals().json) {
      return out({ session: stripForJson(session), stats: sessionStats(session, metricOpts()) });
    }
    printSession(session, {
      turns: o.turns || !!o.prompt,
      verbose: o.verbose,
      only: o.prompt ? Number(o.prompt) : undefined,
      byTool: o.byTool,
    });
  });

program
  .command("stats [project]")
  .description("batching summary across a project's sessions")
  .option("--since <duration>", "only sessions active within this window, e.g. 7d, 12h")
  .option("--top <n>", "tools to show in the per-tool table", "15")
  .action(async (projectRef: string | undefined, o: { since?: string; top: string }) => {
    const project = projectRef ? await resolveProject(projectRef) : await pickProject();
    let sessions = await listSessions(project.dir);
    if (o.since) {
      const cutoff = Date.now() - parseDuration(o.since);
      sessions = sessions.filter((s) => s.mtime >= cutoff);
    }
    const rows = await loadAll(sessions);
    const total = mergeStats(rows.map((r) => r.stats));
    if (globals().json) {
      return out({ project, total: { ...total, runs: undefined }, sessions: rows.map((r) => ({ ...r.info, stats: { ...r.stats, runs: undefined } })) });
    }
    console.log(pc.bold(project.cwd) + pc.dim(`  ${sessions.length} sessions${o.since ? ` in the last ${o.since}` : ""}`));
    console.log();
    console.log(summary(total, { prompts: rows.reduce((s, r) => s + r.session.prompts.length, 0) }));
    console.log();
    console.log(histogram(total));
    console.log();
    console.log(
      table(
        [
          { header: "session" }, { header: "date" }, { header: "turns", align: "right" }, { header: "calls", align: "right" },
          { header: "avg", align: "right" }, { header: "single", align: "right" }, { header: "runs", align: "right" },
          { header: "saved", align: "right" }, { header: "cost", align: "right" }, { header: "title", flex: true },
        ],
        rows.map(({ info, session, stats: st }) => [
          info.id.slice(0, 8), date(session.startedAt), String(st.turns), String(st.toolCalls), st.avgBatch.toFixed(1),
          singlePct(st.singleCallTurns, st.toolTurns), runsCell(st.runs), formatMs(st.savedMs), pc.yellow(formatUsd(st.cost.total)),
          info.title ?? info.firstPrompt ?? "",
        ]),
      ),
    );
    console.log();
    console.log(toolTable(total.byTool, Number(o.top)));
  });

program
  .command("top")
  .description("most expensive sessions across all projects (estimated at API list prices)")
  .option("--since <duration>", "only sessions active within this window, e.g. 7d, 12h", "30d")
  .option("-n, --limit <n>", "sessions to show", "20")
  .option("-p, --project <project>", "only this project")
  .action(async (o: { since: string; limit: string; project?: string }) => {
    const projects = await listProjects();
    const cwdOf = new Map(projects.map((p) => [p.dir, p.cwd]));
    const projectDirs = o.project ? [(await resolveProject(o.project)).dir] : undefined;
    const since = Date.now() - parseDuration(o.since);
    // mtime is never earlier than the last record, so it's a safe prefilter; the records decide.
    const rows = (await loadAll(await listAllSessions({ sinceMs: since, projectDirs }))).filter((r) => r.session.endedAt >= since);
    rows.sort((a, b) => b.stats.cost.total - a.stats.cost.total);
    const total = mergeStats(rows.map((r) => r.stats));
    const shown = rows.slice(0, Number(o.limit));
    if (globals().json) {
      return out({
        total: { cost: total.cost, tokens: total.tokens, byModel: total.byModel },
        sessions: shown.map(({ info, stats: st }) => ({ ...info, project: cwdOf.get(info.projectDir), stats: { ...st, runs: undefined } })),
      });
    }
    console.log(
      pc.bold(`${rows.length} sessions`) + pc.dim(` active in the last ${o.since}${o.project ? ` in ${cwdOf.get(projectDirs![0]!)}` : " across all projects"}`),
    );
    console.log(costLine(total));
    console.log();
    console.log(
      table(
        [
          { header: "#", align: "right" }, { header: "cost", align: "right" }, { header: "share", align: "right" }, { header: "id" },
          { header: "last active" }, { header: "project" }, { header: "turns", align: "right" }, { header: "$/turn", align: "right" },
          { header: "peak ctx", align: "right" }, { header: "batch $", align: "right" }, { header: "title", flex: true },
        ],
        shown.map(({ info, session, stats: st }, i) => [
          String(i + 1),
          pc.bold(pc.yellow(formatUsd(st.cost.total))),
          pct(st.cost.total, total.cost.total),
          info.id.slice(0, 8),
          date(session.endedAt),
          projectLabel(cwdOf.get(info.projectDir) ?? info.projectDir),
          String(st.turns),
          st.turns ? formatUsd(st.cost.total / st.turns) : "",
          formatTokens(st.peakContext),
          st.savedCost ? formatUsd(st.savedCost) : pc.dim("–"),
          info.title ?? info.firstPrompt ?? "",
        ]),
      ),
    );
    console.log();
    console.log(modelTable(total.byModel));
    console.log();
    console.log(pc.dim("Estimated at Anthropic API list prices. Open one with `turn-timer show <id>`."));
  });

program
  .command("serve")
  .description("open the web viewer")
  .option("--port <port>", "port", "4317")
  .option("--no-open", "don't open a browser")
  .action(async (o: { port: string; open: boolean }) => {
    const { startServer } = await import("../server/index.js");
    await startServer({ port: Number(o.port), open: o.open, config: await config(), noCache: globals().cache === false });
  });

// Default: interactive
program.action(async () => {
  const info = await pickSession();
  const session = await withSpinner(`Parsing ${size(info.size)}`, () => load(info));
  printSession(session, {});
  await explore(session);
});

// ---------- printing ----------

function sessionTable(sessions: SessionInfo[]): string {
  return table(
    [
      { header: "#", align: "right" }, { header: "id" }, { header: "last active" }, { header: "size", align: "right" },
      { header: "agents", align: "right" }, { header: "title / first prompt", flex: true },
    ],
    sessions.map((s, i) => [
      String(i + 1), s.id.slice(0, 8), date(s.mtime), size(s.size), s.subagentCount ? String(s.subagentCount) : "",
      s.title ?? s.firstPrompt ?? "",
    ]),
  );
}

function runsCell(runs: BatchableRun[]): string {
  const l = runs.filter((r) => r.kind === "likely").length;
  const p = runs.length - l;
  if (!runs.length) return pc.dim("0");
  return `${l ? pc.red(String(l)) : pc.dim("0")}${pc.dim("/")}${p ? pc.yellow(String(p)) : pc.dim("0")}`;
}

function toolTable(byTool: Record<string, { calls: number; soloTurns: number }>, top: number): string {
  const entries = Object.entries(byTool).sort((a, b) => b[1].calls - a[1].calls).slice(0, top);
  return table(
    [{ header: "tool", flex: true }, { header: "calls", align: "right" }, { header: "called alone", align: "right" }, { header: "alone %", align: "right" }],
    entries.map(([name, t]) => [name, String(t.calls), String(t.soloTurns), singlePct(t.soloTurns, t.calls)]),
  );
}

function printSession(s: Session, o: { turns?: boolean; verbose?: boolean; only?: number; byTool?: boolean }) {
  const opts = metricOpts();
  const st = sessionStats(s, opts);
  console.log(pc.bold(s.title ?? s.prompts.find((p) => p.kind === "user")?.text ?? s.id));
  console.log(pc.dim(`${s.cwd} · ${s.id} · ${date(s.startedAt)} → ${date(s.endedAt)} · ${s.files.length - 1} subagent logs`));
  console.log();
  console.log(summary(st, { prompts: s.prompts.length, reminders: s.batchingReminders }));
  console.log();
  console.log(histogram(st));
  console.log();

  const prompts = o.only ? s.prompts.filter((p) => p.index === o.only! - 1) : s.prompts;
  if (o.only && !prompts.length) throw new Error(`No prompt #${o.only}; the session has ${s.prompts.length}.`);
  if (!o.turns) {
    console.log(promptTable(prompts, opts));
  } else {
    for (const p of prompts) printPromptTurns(p, opts, o.verbose);
  }
  if (o.byTool) {
    console.log();
    console.log(toolTable(st.byTool, 25));
  }
  if (Object.keys(st.byModel).length > 1) {
    console.log();
    console.log(modelTable(st.byModel));
  }
}

function promptTable(prompts: Prompt[], opts: MetricOptions): string {
  return table(
    [
      { header: "#", align: "right" }, { header: "turns", align: "right" }, { header: "calls", align: "right" },
      { header: "avg", align: "right" }, { header: "single", align: "right" }, { header: "runs", align: "right" },
      { header: "saved", align: "right" }, { header: "model", align: "right" }, { header: "cost", align: "right" }, { header: "prompt", flex: true },
    ],
    prompts
      .filter((p) => p.turns.length)
      .map((p) => {
        const st = promptStats(p, opts);
        const flags = (p.interrupted ? pc.yellow("⏸ ") : "") + (p.kind === "notification" ? pc.dim("↩ ") : "");
        return [
          String(p.index + 1), String(st.turns), String(st.toolCalls), st.avgBatch.toFixed(1),
          singlePct(st.singleCallTurns, st.toolTurns), runsCell(st.runs), st.savedMs ? formatMs(st.savedMs) : "",
          formatMs(st.modelMs), pc.yellow(formatUsd(st.cost.total)), flags + p.text,
        ];
      }),
  );
}

function toolList(t: Turn): string {
  const groups: [string, number][] = [];
  for (const c of t.toolCalls) {
    const last = groups.at(-1);
    if (last && last[0] === c.name) last[1]++;
    else groups.push([c.name, 1]);
  }
  return groups.map(([n, k]) => (k > 1 ? `${n}×${k}` : n)).join(", ");
}

function printPromptTurns(p: Prompt, opts: MetricOptions, verbose?: boolean) {
  const st = promptStats(p, opts);
  const runOf = new Map<string, BatchableRun>();
  for (const r of st.runs) for (const id of r.turnIds) runOf.set(id, r);
  const width = process.stdout.columns || 120;

  console.log(
    `${pc.bold(pc.cyan(`#${p.index + 1}`))} ${pc.bold(truncate(p.text, width - 10))}\n` +
      pc.dim(`   ${st.turns} turns · ${st.toolCalls} calls · avg ${st.avgBatch.toFixed(1)} · `) +
      singlePct(st.singleCallTurns, st.toolTurns) + pc.dim(" single · ") + runsCell(st.runs) + pc.dim(" runs"),
  );

  const printTurns = (turns: Turn[], indent: string) => {
    turns.forEach((t, i) => {
      const run = runOf.get(t.messageId);
      const mark = run ? (run.kind === "likely" ? pc.red("▌") : pc.yellow("▌")) : " ";
      const n = t.toolCalls.length;
      const badge = n === 0 ? pc.dim("[·]") : n === 1 ? pc.red(`[1]`) : pc.green(`[${n}]`);
      const timing = pc.dim(`${formatMs(turnModelMs(t))}${n ? ` + ${formatMs(turnToolMs(t))}` : ""}`);
      const tools = n ? toolList(t) : pc.dim(t.hasText ? "(text)" : "(thinking)");
      const errs = t.toolCalls.filter((c) => c.isError || c.denied).length;
      console.log(
        `${indent}${mark}${pc.dim(String(i + 1).padStart(4))} ${badge} ${truncate(tools, width - indent.length - 30)}  ${timing}` +
          (errs ? pc.red(` ${errs} err`) : ""),
      );
      if (verbose) {
        for (const c of t.toolCalls) console.log(`${indent}        ${pc.dim(c.name + ":")} ${truncate(c.summary, width - indent.length - 12 - c.name.length)}`);
      }
      if (opts.subagents === false) return;
      for (const c of t.toolCalls) {
        if (!c.subagent) continue;
        const sst = promptStats({ ...p, turns: c.subagent.turns }, opts);
        console.log(
          `${indent}       ${pc.magenta(`┌ subagent: ${c.subagent.agentType}`)} ${pc.dim(truncate(c.subagent.description, 60))} ` +
            pc.dim(`· ${sst.turns} turns · ${sst.toolCalls} calls · `) + singlePct(sst.singleCallTurns, sst.toolTurns) + pc.dim(" single"),
        );
        printTurns(c.subagent.turns, indent + "       " + pc.magenta("│"));
        console.log(`${indent}       ${pc.magenta("└")}`);
      }
    });
  };
  printTurns(p.turns, "");
  console.log();
}

// ---------- interactive ----------

async function pickProject() {
  const { search } = await import("@inquirer/prompts");
  const projects = await listProjects();
  if (!projects.length) throw new Error("No Claude Code projects found.");
  return search({
    message: "Project",
    source: (term) =>
      projects
        .filter((p) => !term || p.cwd.toLowerCase().includes(term.toLowerCase()))
        .map((p) => ({ name: `${p.cwd}  ${pc.dim(`${p.sessionCount} sessions · ${date(p.lastActive)}`)}`, value: p })),
  });
}

async function pickSession(projectRef?: string): Promise<SessionInfo> {
  const { search } = await import("@inquirer/prompts");
  const project = projectRef ? await resolveProject(projectRef) : await pickProject();
  const sessions = await listSessions(project.dir);
  return search({
    message: "Session",
    source: (term) =>
      sessions
        .filter((s) => !term || `${s.id} ${s.title ?? ""} ${s.firstPrompt ?? ""}`.toLowerCase().includes(term.toLowerCase()))
        .map((s) => ({
          name: `${pc.dim(date(s.mtime))}  ${truncate(s.title ?? s.firstPrompt ?? s.id, 70)}  ${pc.dim(size(s.size))}`,
          value: s,
        })),
  });
}

async function explore(session: Session) {
  const { select } = await import("@inquirer/prompts");
  const opts = metricOpts();
  for (;;) {
    const choice = await select<number>({
      message: "Expand a prompt",
      pageSize: 15,
      choices: [
        { name: pc.dim("exit"), value: -1 },
        ...session.prompts
          .filter((p) => p.turns.length)
          .map((p) => {
            const st = promptStats(p, opts);
            return {
              name: `#${String(p.index + 1).padEnd(4)} ${String(st.toolCalls).padStart(4)} calls  ${truncate(p.text, 70)}`,
              value: p.index,
            };
          }),
      ],
    });
    if (choice < 0) return;
    console.log();
    printPromptTurns(session.prompts[choice]!, opts, true);
  }
}

// ---------- helpers ----------

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (globals().json || !process.stderr.isTTY) return fn();
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  const timer = setInterval(() => process.stderr.write(`\r${pc.dim(`${frames[i++ % frames.length]} ${label}`)}\x1b[K`), 80);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    process.stderr.write("\r\x1b[K");
  }
}

/** Parse (or load from cache) each session, with a progress line on a TTY. */
async function loadAll(infos: SessionInfo[]) {
  const rows: { info: SessionInfo; session: Session; stats: Stats }[] = [];
  const showProgress = !globals().json && process.stderr.isTTY;
  for (const [i, info] of infos.entries()) {
    if (showProgress) process.stderr.write(`\r${pc.dim(`Parsing ${i + 1}/${infos.length} (${size(info.size)})`)}\x1b[K`);
    const session = await load(info);
    rows.push({ info, session, stats: sessionStats(session, metricOpts()) });
  }
  if (showProgress) process.stderr.write("\r\x1b[K");
  return rows;
}

const projectLabel = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(s.trim());
  if (!m) throw new Error(`Invalid duration "${s}" (use e.g. 30m, 12h, 7d, 2w)`);
  const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] as "m" | "h" | "d" | "w"];
  return Number(m[1]) * unit;
}

/** Session JSON without byte offsets and file indexes (internal plumbing). */
function stripForJson(s: Session): Session {
  return JSON.parse(JSON.stringify(s, (k, v) => (k === "offset" || k === "resultOffset" || k === "file" ? undefined : v)));
}

program.parseAsync().catch((e: unknown) => {
  if (e instanceof Error && e.name === "ExitPromptError") process.exit(130);
  console.error(pc.red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
