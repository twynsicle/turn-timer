import { homedir, platform } from "node:os";
import { join } from "node:path";

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

export function cacheDir(): string {
  if (process.env.CLAUDE_SESSIONS_CACHE_DIR) return process.env.CLAUDE_SESSIONS_CACHE_DIR;
  const p = platform();
  if (p === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "claude-session-viewer", "cache");
  }
  if (p === "darwin") return join(homedir(), "Library", "Caches", "claude-session-viewer");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "claude-session-viewer");
}

/**
 * Best-effort decode of a project folder name when no record gives us the real cwd.
 * Lossy: Claude Code replaces every non-alphanumeric character with "-".
 */
export function decodeProjectDir(dir: string): string {
  const m = /^([A-Za-z])--(.*)$/.exec(dir);
  if (m) return `${m[1]}:\\${m[2]!.replace(/-/g, "\\")}`;
  return dir.replace(/-/g, "/");
}
