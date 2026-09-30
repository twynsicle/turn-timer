// Tool classification and input summarising. Pure (no Node imports).

import type { ToolCategory } from "./types.js";

type Input = Record<string, unknown>;

const READ_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead", "LSP", "ToolSearch", "TaskOutput", "TaskList", "TaskGet",
]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const EXEC_TOOLS = new Set(["Bash", "PowerShell"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** Cap on the input text kept per call. */
export const INPUT_CAP = 1000;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function classify(name: string, input: unknown): { category: ToolCategory; summary: string } {
  const inp: Input = input && typeof input === "object" ? (input as Input) : {};
  const filePath = str(inp.file_path) ?? str(inp.notebook_path) ?? str(inp.path);
  if (EXEC_TOOLS.has(name)) return { category: "exec", summary: oneLine(str(inp.command) ?? "") };
  if (READ_TOOLS.has(name)) {
    const pattern = str(inp.pattern) ?? str(inp.query) ?? str(inp.url);
    const summary = [pattern, filePath].filter(Boolean).join("  in ") || genericSummary(inp);
    return { category: "read", summary: oneLine(summary) };
  }
  if (EDIT_TOOLS.has(name)) return { category: "edit", summary: oneLine(filePath ?? genericSummary(inp)) };
  if (AGENT_TOOLS.has(name)) return { category: "agent", summary: oneLine(str(inp.description) ?? str(inp.subagent_type) ?? "") };
  return { category: name.startsWith("mcp__") ? "mcp" : "other", summary: oneLine(genericSummary(inp)) };
}

/** The input as a person would want to read it: shell commands as-is, anything else as JSON. */
export function inputText(input: unknown): string {
  let text: string;
  const o = input && typeof input === "object" ? (input as Input) : undefined;
  if (o && typeof o.command === "string" && Object.keys(o).every((k) => ["command", "description", "timeout", "run_in_background"].includes(k))) {
    text = o.command + (typeof o.description === "string" ? `\n\n# ${o.description}` : "");
  } else {
    text = JSON.stringify(input, null, 2) ?? "";
  }
  return cap(text, INPUT_CAP);
}

export function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… ${(text.length - max).toLocaleString("en-US")} more characters` : text;
}

/** The first non-empty string in the input: top-level fields first, then nested ones (AskUserQuestion). */
function genericSummary(inp: unknown, depth = 0): string {
  if (!inp || typeof inp !== "object" || depth > 3) return "";
  const values = Object.values(inp);
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  for (const v of values) {
    const s = genericSummary(v, depth + 1);
    if (s) return s;
  }
  return "";
}

export function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
