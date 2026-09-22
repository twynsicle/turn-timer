import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, mergeConfig } from "./config.js";

/** Load config from an explicit path, else ./turn-timer.config.json, else ~/.turn-timer.json. */
export async function loadConfig(explicit?: string): Promise<Config> {
  const candidates = explicit ? [explicit] : [join(process.cwd(), "turn-timer.config.json"), join(homedir(), ".turn-timer.json")];
  for (const p of candidates) {
    let text: string;
    try {
      text = await readFile(p, "utf8");
    } catch {
      if (explicit) throw new Error(`Config file not found: ${p}`);
      continue;
    }
    try {
      return mergeConfig(JSON.parse(text));
    } catch (e) {
      throw new Error(`Invalid config ${p}: ${(e as Error).message}`);
    }
  }
  return mergeConfig(undefined);
}
