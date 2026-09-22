import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadSession } from "../core/cache.js";
import type { Config } from "../core/config.js";
import { listProjects, listSessions, subagentFiles } from "../core/discover.js";
import { readLineAt, tryParse } from "../core/lines.js";
import { mergeStats, runTotals, sessionStats } from "../core/metrics.js";
import { projectsDir } from "../core/paths.js";
import { blocks, toolResultText } from "../core/records.js";
import type { Session } from "../core/types.js";

export interface ServerOptions {
  port: number;
  open: boolean;
  config: Config;
  noCache?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/** Result text returned by /api/detail is capped; the full text can be huge. */
const DETAIL_CAP = 200_000;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export async function startServer(opts: ServerOptions): Promise<void> {
  const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
  const hasWeb = existsSync(join(webRoot, "index.html"));

  // Small in-memory LRU so flipping between sessions doesn't re-read cache files.
  const sessions = new Map<string, Session>();
  const getSession = async (project: string, id: string): Promise<{ session: Session; path: string }> => {
    if (!SAFE_SEGMENT.test(project) || !SAFE_SEGMENT.test(id)) throw new HttpError(400, "bad session reference");
    const path = join(projectsDir(), project, `${id}.jsonl`);
    try {
      await stat(path);
    } catch {
      throw new HttpError(404, "session not found");
    }
    const session = await loadSession(path, opts.config, { noCache: opts.noCache });
    sessions.delete(path);
    sessions.set(path, session);
    while (sessions.size > 4) sessions.delete(sessions.keys().next().value!);
    return { session, path };
  };

  const projectDir = async (raw: string): Promise<string> => {
    const dir = decodeURIComponent(raw);
    if (!SAFE_SEGMENT.test(dir)) throw new HttpError(400, "bad project");
    try {
      await stat(join(projectsDir(), dir));
    } catch {
      throw new HttpError(404, "project not found");
    }
    return dir;
  };

  const routes: [RegExp, (m: RegExpMatchArray, url: URL) => Promise<unknown>][] = [
    [/^\/api\/projects$/, async () => listProjects()],
    [
      /^\/api\/projects\/([^/]+)\/sessions$/,
      async (m) => listSessions(await projectDir(m[1]!)),
    ],
    [
      /^\/api\/projects\/([^/]+)\/stats$/,
      async (m, url) => {
        const dir = await projectDir(m[1]!);
        const since = Number(url.searchParams.get("sinceDays") ?? 0);
        const subagents = url.searchParams.get("subagents") !== "false";
        let infos = await listSessions(dir);
        if (since > 0) infos = infos.filter((s) => s.mtime >= Date.now() - since * 86400e3);
        const rows = [];
        for (const info of infos) {
          const { session } = await getSession(dir, info.id);
          const st = sessionStats(session, { subagents });
          rows.push({ info, stats: st, prompts: session.prompts.length, reminders: session.batchingReminders });
        }
        const total = mergeStats(rows.map((r) => r.stats));
        // Runs are per-turn detail; the overview only needs counts.
        const slim = (s: typeof total) => ({ ...s, runs: undefined, runTotals: runTotals(s.runs) });
        return {
          total: slim(total),
          sessions: rows.map((r) => ({ ...r.info, prompts: r.prompts, reminders: r.reminders, stats: slim(r.stats) })),
        };
      },
    ],
    [
      /^\/api\/sessions\/([^/]+)\/([^/]+)$/,
      async (m) => (await getSession(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!))).session,
    ],
    [
      /^\/api\/sessions\/([^/]+)\/([^/]+)\/detail$/,
      async (m, url) => {
        const { session, path } = await getSession(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
        const fileIdx = Number(url.searchParams.get("file"));
        const offset = Number(url.searchParams.get("offset"));
        const resultOffset = url.searchParams.get("resultOffset");
        const toolUseId = url.searchParams.get("id") ?? "";
        const files = [path, ...(await subagentFiles(path))];
        const file = files[fileIdx];
        if (!file || session.files[fileIdx] !== file || !Number.isSafeInteger(offset) || offset < 0) {
          throw new HttpError(400, "bad detail reference");
        }
        const useRec = tryParse(await readLineAt(file, offset));
        const use = blocks(useRec).find((b) => b?.type === "tool_use" && b.id === toolUseId);
        let result: { text: string; truncated: boolean; isError: boolean } | undefined;
        if (resultOffset !== null && Number.isSafeInteger(Number(resultOffset))) {
          const resRec = tryParse(await readLineAt(file, Number(resultOffset)));
          const block = blocks(resRec).find((b) => b?.type === "tool_result" && b.tool_use_id === toolUseId);
          if (block) {
            const text = toolResultText(block) || (Array.isArray(block.content) ? "[non-text result]" : "");
            result = { text: text.slice(0, DETAIL_CAP), truncated: text.length > DETAIL_CAP, isError: block.is_error === true };
          }
        }
        return { input: use?.input ?? null, result };
      },
    ],
  ];

  const send = (req: IncomingMessage, res: ServerResponse, status: number, body: string | Buffer, type: string) => {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    const gzip = buf.length > 8192 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    res.end(gzip ? gzipSync(buf) : buf);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        for (const [re, handler] of routes) {
          const m = url.pathname.match(re);
          if (m) return send(req, res, 200, JSON.stringify(await handler(m, url)), MIME[".json"]!);
        }
        throw new HttpError(404, "not found");
      }
      if (!hasWeb) {
        return send(req, res, 200, "Web viewer not built. Run `npm run build` (or `npm run dev:web` for development).", "text/plain");
      }
      // Static files; unknown paths fall back to index.html.
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
      let file = join(webRoot, rel);
      if (!file.startsWith(webRoot.replace(/[/\\]$/, "") + sep) || !existsSync(file) || (await stat(file)).isDirectory()) {
        file = join(webRoot, "index.html");
      }
      send(req, res, 200, await readFile(file), MIME[extname(file)] ?? "application/octet-stream");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(req, res, status, JSON.stringify({ error: (e as Error).message }), MIME[".json"]!);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const address = `http://localhost:${opts.port}`;
  console.log(`turn-timer viewer running at ${address}  (Ctrl+C to stop)`);
  if (opts.open) openBrowser(address);
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // no browser available; the URL is printed above
  }
}
