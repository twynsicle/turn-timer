// Helpers for interpreting raw JSONL records. Pure.

import { oneLine } from "./classify.js";
import type { PromptKind } from "./types.js";

export const INTERRUPT_PREFIX = "[Request interrupted by user";

/** Prompts are kept whole up to this length. */
export const PROMPT_CAP = 20_000;

export function ts(rec: any): number {
  const t = rec?.timestamp ? Date.parse(rec.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Content blocks of a record's message, always as an array. */
export function blocks(rec: any): any[] {
  const c = rec?.message?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return [];
}

/** A user record carrying tool results. It may also carry text (an interrupt note, a queued message). */
export function hasToolResults(rec: any): boolean {
  return blocks(rec).some((x) => x?.type === "tool_result");
}

/** Plain text of a user record (text blocks only). */
export function userText(rec: any): string {
  return blocks(rec)
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Interpret a user text record as prompt text. Returns undefined for records that never
 * carry the prompt itself (meta, compact summaries, interrupts, command caveats/stdout).
 */
export function promptTextOf(rec: any): { text: string; kind: PromptKind } | undefined {
  if (rec?.isMeta || rec?.isCompactSummary) return undefined;
  const text = userText(rec).trim();
  if (!text) {
    // A pasted image with no message is still a prompt.
    return blocks(rec).some((b) => b?.type === "image") ? { text: "[image]", kind: "user" } : undefined;
  }
  if (text.startsWith(INTERRUPT_PREFIX)) return undefined;
  if (text.startsWith("<local-command-")) return undefined;
  if (text.startsWith("<task-notification>")) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1];
    return { text: oneLine(summary ? `Task notification: ${summary}` : "Task notification", 300), kind: "notification" };
  }
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1];
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return { text: oneLine(args ? `${cmd.trim()} ${args}` : cmd.trim(), 300), kind: "command" };
  }
  return { text: text.length > PROMPT_CAP ? `${text.slice(0, PROMPT_CAP)}…` : text, kind: "user" };
}

/** Text of the placeholder prompt that holds turns logged before any prompt (e.g. a resumed session). */
export const NO_PROMPT = "(no prompt)";

/** Commands that manage the session rather than ask for work; they say nothing about what it was for. */
const HOUSEKEEPING = new Set(
  "add-dir agents bug clear compact config context cost doctor effort exit export fast feedback help hooks ide login logout mcp memory model output-style permissions plugin quit release-notes rename resume rewind statusline status terminal-setup theme usage vim"
    .split(" ")
    .map((c) => `/${c}`),
);

/** Whether a prompt says what the session was about: typed text, or a command that asks for work. */
export function isMeaningfulPrompt(p: { kind: PromptKind; text: string }): boolean {
  const text = p.text.trim();
  if (!text || text === NO_PROMPT) return false;
  if (p.kind === "notification") return false;
  if (p.kind === "command") return !HOUSEKEEPING.has(text.split(/\s/)[0]!);
  return true;
}

/** Text of a tool_result block's content. */
export function toolResultText(block: any): string {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((x) => x?.type === "text" && typeof x.text === "string")
      .map((x) => x.text as string)
      .join("\n");
  }
  return "";
}
