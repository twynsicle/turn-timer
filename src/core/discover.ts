import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { readLines, tryParse } from "./lines.js";
import { decodeProjectDir, projectsDir } from "./paths.js";
import { promptTextOf, ts } from "./records.js";
import type { ProjectInfo, SessionInfo } from "./types.js";

const HEAD_BYTES = 4 << 20;
const HEAD_LINES = 400;
const TAIL_BYTES = 256 << 10;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function listProjects(root = projectsDir()): Promise<ProjectInfo[]> {
  if (!(await exists(root))) return [];
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  const out: ProjectInfo[] = [];
  for (const d of dirs) {
    const sessions = await listSessionFiles(join(root, d.name));
    if (!sessions.length) continue;
    const newest = sessions.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    const head = await scanHead(newest.path, d.name);
    out.push({
      dir: d.name,
      cwd: displayCwd(d.name, head.cwds),
      sessionCount: sessions.length,
      lastActive: newest.mtime,
    });
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

async function listSessionFiles(dir: string): Promise<{ id: string; path: string; size: number; mtime: number }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const path = join(dir, e.name);
    const s = await stat(path);
    if (s.size === 0) continue;
    out.push({ id: e.name.slice(0, -".jsonl".length), path, size: s.size, mtime: s.mtimeMs });
  }
  return out;
}

export async function listSessions(projectDir: string, root = projectsDir()): Promise<SessionInfo[]> {
  const dir = join(root, projectDir);
  const files = await listSessionFiles(dir);
  const out: SessionInfo[] = [];
  for (const f of files) {
    const [head, tail, subagentCount] = await Promise.all([
      scanHead(f.path, projectDir),
      scanTail(f.path, f.size),
      countSubagents(join(dir, f.id, "subagents")),
    ]);
    out.push({
      id: f.id,
      projectDir,
      path: f.path,
      size: f.size,
      mtime: f.mtime,
      cwd: head.cwd,
      title: tail.title ?? head.title,
      firstPrompt: head.firstPrompt,
      startedAt: head.startedAt,
      subagentCount,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function subagentFiles(sessionPath: string): Promise<string[]> {
  const dir = join(sessionPath.slice(0, -".jsonl".length), "subagents");
  if (!(await exists(dir))) return [];
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith(".jsonl")).sort().map((n) => join(dir, n));
}

async function countSubagents(dir: string): Promise<number> {
  if (!(await exists(dir))) return 0;
  return (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).length;
}

/** Claude Code names project folders by replacing every non-alphanumeric char with "-". */
export const encodeCwd = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Pick the cwd that produced this folder name. A session can move between directories
 * (e.g. into a worktree), so the first cwd in the log isn't always the folder's.
 */
function displayCwd(dir: string, cwds: string[]): string {
  const exact = cwds.find((c) => encodeCwd(c) === dir);
  if (exact) return exact;
  const prefix = cwds.filter((c) => dir.startsWith(encodeCwd(c))).sort((a, b) => b.length - a.length)[0];
  if (prefix) {
    const rest = dir.slice(encodeCwd(prefix).length).replace(/^-+/, "");
    return rest ? `${prefix}${prefix.includes("\\") ? "\\" : "/"}${rest}` : prefix;
  }
  return cwds[0] ?? decodeProjectDir(dir);
}

interface Head {
  cwd?: string;
  cwds: string[];
  title?: string;
  firstPrompt?: string;
  startedAt?: number;
}

async function scanHead(path: string, dir?: string): Promise<Head> {
  const head: Head = { cwds: [] };
  let n = 0;
  for await (const line of readLines(path, 0, HEAD_BYTES - 1)) {
    if (++n > HEAD_LINES) break;
    // Skip parsing giant lines (tool results) — they never hold what we're after.
    if (line.text.length > 200_000) continue;
    const rec = tryParse(line.text);
    if (!rec) continue;
    if (!head.startedAt && ts(rec)) head.startedAt = ts(rec);
    if (typeof rec.cwd === "string") {
      head.cwd ??= rec.cwd;
      if (!head.cwds.includes(rec.cwd)) head.cwds.push(rec.cwd);
    }
    if (rec.type === "custom-title" && rec.customTitle) head.title = rec.customTitle;
    if (!head.firstPrompt && rec.type === "user" && !rec.isSidechain) {
      const p = promptTextOf(rec);
      if (p) head.firstPrompt = p.text;
    }
    const cwdDone = dir ? head.cwds.some((c) => encodeCwd(c) === dir) : !!head.cwd;
    if (cwdDone && head.firstPrompt && head.startedAt) break;
  }
  return head;
}

async function scanTail(path: string, size: number): Promise<{ title?: string }> {
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let title: string | undefined;
    for (const text of buf.toString("utf8").split("\n")) {
      if (!text.includes('"custom-title"')) continue;
      const rec = tryParse(text);
      if (rec?.type === "custom-title" && rec.customTitle) title = rec.customTitle;
    }
    return { title };
  } finally {
    await fh.close();
  }
}
