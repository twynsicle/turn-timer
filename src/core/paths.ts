import { homedir } from "node:os";
import { join } from "node:path";

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectsDir(): string {
  return join(claudeConfigDir(), "projects");
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
