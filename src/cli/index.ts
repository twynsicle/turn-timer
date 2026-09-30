#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { loadSession } from "../core/cache.js";
import { formatUsd } from "../core/cost.js";
import { listAllSessions, listProjects } from "../core/discover.js";
import { analyzeSession, formatMs } from "../core/metrics.js";
import { cacheDir, projectsDir } from "../core/paths.js";
import {
  INDEX_ELEMENT_ID,
  INDEX_PLACEHOLDER,
  REPORT_VERSION,
  type ReportIndex,
  SESSIONS_DIR,
  SESSION_CALLBACK,
  type SessionData,
  type SessionRow,
  scriptSafeJson,
  sessionRow,
  trimPreviews,
} from "../core/report-data.js";
import type { SessionInfo } from "../core/types.js";

interface Options {
  since: string;
  project?: string;
  out: string;
  open: boolean;
  cache: boolean;
}

const program = new Command()
  .name("claude-sessions")
  .description("Build an HTML report of your Claude Code sessions: what they cost, where the time went, and cache misses.")
  .option("-s, --since <days>", "only sessions active in the last N days (0 = all)", "30")
  .option("-p, --project <text>", "only projects whose path contains this text")
  .option("-o, --out <dir>", "folder to write the report to", join(cacheDir(), "report"))
  .option("--no-open", "don't open the report in a browser")
  .option("--no-cache", "re-parse every log instead of reusing earlier parses")
  .action((opts: Options) => build(opts))
  .showHelpAfterError();

async function build(opts: Options) {
  const sinceDays = Number(opts.since.replace(/d$/, ""));
  if (!Number.isFinite(sinceDays) || sinceDays < 0) throw new Error(`--since expects a number of days, got "${opts.since}"`);
  const since = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0;
  const shell = await reportShell();

  let projects = await listProjects();
  if (opts.project) {
    const needle = opts.project.toLowerCase();
    projects = projects.filter((p) => p.cwd.toLowerCase().includes(needle) || p.dir.toLowerCase().includes(needle));
    if (!projects.length) throw new Error(`No project path contains "${opts.project}".`);
  }
  // mtime is never earlier than a log's last record, so it's a safe prefilter.
  const infos = await listAllSessions({ sinceMs: since, projectDirs: projects.map((p) => p.dir) });
  if (!infos.length) throw new Error(`No sessions found in ${projectsDir()}${sinceDays ? ` in the last ${sinceDays} days` : ""}.`);

  const out = resolve(opts.out);
  const sessionsDir = join(out, SESSIONS_DIR);
  await clearSessionsDir(out, sessionsDir);
  await mkdir(sessionsDir, { recursive: true });

  const started = Date.now();
  const rows: SessionRow[] = [];
  const failed: ReportIndex["failed"] = [];
  const progress = new Progress(infos.length);
  await forEachLimit(infos, 4, async (info) => {
    try {
      const row = await processSession(info, sessionsDir, opts.cache, since);
      if (row) rows.push(row);
    } catch (e) {
      failed.push({ path: info.path, error: (e as Error).message });
    }
    progress.tick(info);
  });
  progress.done();

  rows.sort((a, b) => b.endedAt - a.endedAt);
  const index: ReportIndex = {
    version: REPORT_VERSION,
    generatedAt: Date.now(),
    sinceDays,
    projectFilter: opts.project,
    sessions: rows,
    failed,
  };
  const html = injectIndex(shell, index);
  const file = join(out, "index.html");
  await writeFile(file, html);

  const total = rows.reduce((s, r) => s + r.cost.total, 0);
  console.log(
    `${pc.bold(String(rows.length))} sessions · ${pc.bold(formatUsd(total))} estimated · built in ${formatMs(Date.now() - started)}`,
  );
  for (const f of failed) console.log(pc.yellow(`Skipped ${f.path}: ${f.error}`));
  console.log(`Report: ${pc.cyan(file)}`);
  if (opts.open) openFile(file);
}

async function processSession(info: SessionInfo, dir: string, cache: boolean, since: number): Promise<SessionRow | undefined> {
  const session = await loadSession(info.path, { noCache: !cache });
  if (!session.prompts.length || session.endedAt < since) return undefined;
  const row = sessionRow(session, info, analyzeSession(session));
  const data: SessionData = { key: row.key, session: trimPreviews(session) };
  await writeFile(join(dir, `${row.key}.js`), `${SESSION_CALLBACK}(${scriptSafeJson(data)});\n`);
  return row;
}

function injectIndex(shell: string, index: ReportIndex): string {
  const at = shell.indexOf(INDEX_PLACEHOLDER);
  if (at === -1) throw new Error("The report page has no index placeholder; rebuild it with `npm run build`.");
  // Concatenate rather than String.replace: `$&`, `$'` and `$$` in the data would be read as patterns.
  const close = INDEX_PLACEHOLDER.lastIndexOf("</script>");
  const filled = INDEX_PLACEHOLDER.slice(0, close) + scriptSafeJson(index) + INDEX_PLACEHOLDER.slice(close);
  return shell.slice(0, at) + filled + shell.slice(at + INDEX_PLACEHOLDER.length);
}

/** Empty `<out>/sessions`, but only when it belongs to an earlier report: never someone else's folder. */
async function clearSessionsDir(out: string, sessionsDir: string) {
  if (!existsSync(sessionsDir)) return;
  const page = await readFile(join(out, "index.html"), "utf8").catch(() => "");
  const ours = (await readdir(sessionsDir)).every((n) => /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.js$/.test(n));
  if (!page.includes(`id="${INDEX_ELEMENT_ID}"`) && !ours) {
    throw new Error(`${sessionsDir} already exists and isn't from an earlier report. Choose another --out folder.`);
  }
  await rm(sessionsDir, { recursive: true, force: true });
}

/** The built page: dist/report/shell.html, beside this file once built, or under dist in development. */
async function reportShell(): Promise<string> {
  const candidates = [new URL("../report/shell.html", import.meta.url), new URL("../../dist/report/shell.html", import.meta.url)].map((u) =>
    fileURLToPath(u),
  );
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("The report page isn't built yet. Run `npm run build` first.");
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
  tick(info: SessionInfo) {
    this.n++;
    if (!this.tty) return;
    const label = (info.title ?? info.firstPrompt ?? info.id).replace(/\s+/g, " ").slice(0, 50);
    process.stderr.write(`\r\x1b[2KReading sessions ${this.n}/${this.total}  ${pc.dim(label)}`);
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
  console.error(pc.red(e.message));
  process.exitCode = 1;
});
