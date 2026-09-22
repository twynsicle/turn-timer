import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import { subagentFiles } from "./discover.js";
import { parseSession } from "./parse.js";
import { cacheDir } from "./paths.js";
import type { Session } from "./types.js";

/** Bump when the Session shape or parsing rules change, to invalidate old caches. */
const CACHE_VERSION = 2;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

async function fingerprint(path: string, config: Config): Promise<string> {
  const files = [path, ...(await subagentFiles(path))];
  const parts = await Promise.all(
    files.map(async (f) => {
      const s = await stat(f);
      return `${f}:${s.size}:${s.mtimeMs}`;
    }),
  );
  return sha1(`${CACHE_VERSION}\n${JSON.stringify(config)}\n${parts.join("\n")}`);
}

/**
 * Parse a session, reusing the cached parse when its files and the config are unchanged.
 * One cache file per session (keyed by path), holding the fingerprint it was built from.
 */
export async function loadSession(path: string, config: Config, opts: { noCache?: boolean } = {}): Promise<Session> {
  if (opts.noCache) return parseSession(path, config);
  const key = await fingerprint(path, config);
  const file = join(cacheDir(), `${sha1(path)}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8")) as { key: string; session: Session };
    if (cached.key === key) return cached.session;
  } catch {
    // miss
  }
  const session = await parseSession(path, config);
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(file, JSON.stringify({ key, session }));
  } catch {
    // cache is best-effort
  }
  return session;
}
