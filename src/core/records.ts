// Helpers for interpreting raw JSONL records. Pure.

import { oneLine } from "./classify.js";
import type { PromptKind } from "./types.js";

export const INTERRUPT_PREFIX = "[Request interrupted by user";

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

export function isToolResultRecord(rec: any): boolean {
  const b = blocks(rec);
  return b.length > 0 && b.every((x) => x?.type === "tool_result");
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
  if (!text || text.startsWith(INTERRUPT_PREFIX)) return undefined;
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
  return { text: oneLine(text, 300), kind: "user" };
}

/** Text of a tool_result block's content, for the dependency heuristic. */
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
