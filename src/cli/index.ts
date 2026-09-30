#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { formatUsd } from "../core/cost.js";
import { listAllSessions, listProjects } from "../core/discover.js";
import { analyzeSession, formatMs } from "../core/metrics.js";
import { parseSession } from "../core/parse.js";
import { projectsDir } from "../core/paths.js";
import { INDEX_PLACEHOLDER, REPORT_VERSION, type ReportIndex, type SessionRow, dataElements, sessionRow, trimPreviews } from "../core/report-data.js";
import type { Session } from "../core/types.js";

// Session logs are sensitive. The report file is the only thing this writes: no cache, no
// temp files, no log files. Console output is progress and totals only, never log contents.

/** Written to the current working directory. */
const REPORT_FILE = "claude-sessions-report.html";

interface Options {
  since: string;
  project?: string;
  open: boolean;
}

/** An error whose message is ours and safe to print. Anything else may quote a log line. */
class CliError extends Error {}

const program = new Command()
  .name("claude-sessions")
  .description(`Build an HTML report of your Claude Code sessions (what they cost, where the time went, and cache misses) as ${REPORT_FILE} in the current folder.`)
  .option("-s, --since <days>", "only sessions active in the last N days (0 = all)", "30")
  .option("-p, --project <text>", "only projects whose path contains this text")
  .option("--no-open", "don't open the report in a browser")
  .action((opts: Options) => build(opts))
  .showHelpAfterError();

async function build(opts: Options) {
  const sinceDays = Number(opts.since.replace(/d$/, ""));
  if (!Number.isFinite(sinceDays) || sinceDays < 0) throw new CliError(`--since expects a number of days, got "${opts.since}"`);
  const since = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0;
  const shell = await reportShell();

  let projects = await listProjects();
  if (opts.project) {
    const needle = opts.project.toLowerCase();
    projects = projects.filter((p) => p.cwd.toLowerCase().includes(needle) || p.dir.toLowerCase().includes(needle));
    if (!projects.length) throw new CliError(`No project path contains "${opts.project}".`);
  }
  // mtime is never earlier than a log's last record, so it's a safe prefilter.
  const infos = await listAllSessions({ sinceMs: since, projectDirs: projects.map((p) => p.dir) });
  if (!infos.length) throw new CliError(`No sessions found in ${projectsDir()}${sinceDays ? ` in the last ${sinceDays} days` : ""}.`);

  const started = Date.now();
  const rows: SessionRow[] = [];
  const sessions = new Map<string, Session>();
  const failed: ReportIndex["failed"] = [];
  const progress = new Progress(infos.length);
  await forEachLimit(infos, 4, async (info) => {
    try {
      const session = await parseSession(info.path);
      if (session.prompts.length && session.endedAt >= since) {
        const row = sessionRow(session, info, analyzeSession(session));
        rows.push(row);
        sessions.set(row.key, session);
      }
    } catch (e) {
      failed.push({ path: info.path, error: safeReason(e) });
    }
    progress.tick();
  });
  progress.done();

  rows.sort((a, b) => b.endedAt - a.endedAt);
  trimPreviews(sessions.values());
  const index: ReportIndex = {
    version: REPORT_VERSION,
    generatedAt: Date.now(),
    sinceDays,
    projectFilter: opts.project,
    sessions: rows,
    failed,
  };
  const file = resolve(REPORT_FILE);
  await writeReport(file, fillShell(shell, dataElements(index, sessions)));

  const total = rows.reduce((s, r) => s + r.cost.total, 0);
  console.log(
    `${pc.bold(String(rows.length))} sessions · ${pc.bold(formatUsd(total))} estimated · built in ${formatMs(Date.now() - started)}`,
  );
  for (const f of failed) console.log(pc.yellow(`Skipped ${f.path}: ${f.error}`));
  console.log(`Report: ${pc.cyan(file)}`);
  if (opts.open) openFile(file);
}

/** Why a log couldn't be read, without the error message: a JSON error can quote the log. */
function safeReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code ? `couldn't be read (${code})` : `couldn't be parsed (${(e as Error)?.name ?? "error"})`;
}

function fillShell(shell: string, data: string): string {
  const at = shell.indexOf(INDEX_PLACEHOLDER);
  if (at === -1) throw new CliError("The report page has no index placeholder; rebuild it with `npm run build`.");
  // Concatenate rather than String.replace: `$&`, `$'` and `$$` in the data would be read as patterns.
  return shell.slice(0, at) + data + shell.slice(at + INDEX_PLACEHOLDER.length);
}

/** Write the report, removing it again if the write fails part-way so no partial copy is left. */
async function writeReport(file: string, html: string) {
  try {
    await writeFile(file, html);
  } catch (e) {
    await rm(file, { force: true }).catch(() => {});
    throw new CliError(`Couldn't write ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`);
  }
}

/** The built page: dist/report/shell.html, beside this file once built, or under dist in development. */
async function reportShell(): Promise<string> {
  const candidates = [new URL("../report/shell.html", import.meta.url), new URL("../../dist/report/shell.html", import.meta.url)].map((u) =>
    fileURLToPath(u),
  );
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new CliError("The report page isn't built yet. Run `npm run build` first.");
  return readFile(found, "utf8");
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

class Progress {
  private n = 0;
  private readonly tty = process.stderr.isTTY;
  constructor(private readonly total: number) {}
  tick() {
    this.n++;
    // Counts only: titles and prompts are session contents.
    if (this.tty) process.stderr.write(`\r\x1b[2KReading sessions ${this.n}/${this.total}`);
  }
  done() {
    if (this.tty) process.stderr.write("\r\x1b[2K");
  }
}

function openFile(path: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", path]] : process.platform === "darwin" ? ["open", [path]] : ["xdg-open", [path]];
  // A missing opener fails through the 'error' event, not a throw; the path is printed above.
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser available
  }
}

await program.parseAsync().catch((e: Error) => {
  // Any other error can carry text from the logs: say only what kind it was.
  console.error(pc.red(e instanceof CliError ? e.message : `Failed: ${(e as NodeJS.ErrnoException).code ?? e.name}`));
  process.exitCode = 1;
});
