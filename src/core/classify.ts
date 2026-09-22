// Tool classification and input summarising. Pure (no Node imports).

import type { Config } from "./config.js";
import type { ToolCategory } from "./types.js";

export interface Classified {
  category: ToolCategory;
  readOnly: boolean;
  summary: string;
  paths: string[];
  /** Strings from the input worth searching for in earlier results (dependency heuristic). */
  needles: string[];
}

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function classify(name: string, input: unknown, config: Config): Classified {
  const inp: Input = input && typeof input === "object" ? (input as Input) : {};
  const filePath = str(inp.file_path) ?? str(inp.notebook_path) ?? str(inp.path);
  const paths = filePath ? [normalizePath(filePath)] : [];

  if (config.execTools.includes(name)) {
    const command = str(inp.command) ?? "";
    return {
      category: "exec",
      readOnly: isReadOnlyCommand(command, config.readOnlyCommands),
      summary: oneLine(command),
      paths: [],
      needles: commandNeedles(command),
    };
  }
  if (config.readOnlyTools.includes(name)) {
    const pattern = str(inp.pattern) ?? str(inp.query) ?? str(inp.url);
    const summary = [pattern, filePath].filter(Boolean).join("  in ") || genericSummary(inp);
    return {
      category: "read",
      readOnly: true,
      summary: oneLine(summary),
      paths,
      needles: [...pathNeedles(filePath), ...(pattern && pattern.length >= 4 ? [pattern] : [])],
    };
  }
  if (config.editTools.includes(name)) {
    return {
      category: "edit",
      readOnly: false,
      summary: oneLine(filePath ?? genericSummary(inp)),
      paths,
      needles: pathNeedles(filePath),
    };
  }
  if (config.agentTools.includes(name)) {
    const desc = str(inp.description) ?? str(inp.subagent_type) ?? "";
    return { category: "agent", readOnly: false, summary: oneLine(desc), paths: [], needles: [] };
  }
  return {
    category: name.startsWith("mcp__") ? "mcp" : "other",
    readOnly: false,
    summary: oneLine(genericSummary(inp)),
    paths,
    needles: pathNeedles(filePath),
  };
}

/**
 * A command is read-only when every segment (split on && || ; |) starts with an allowlisted
 * command, and there's no output redirection to a file.
 */
export function isReadOnlyCommand(command: string, allow: string[]): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // Redirection to a file (but allow 2>&1, >/dev/null, 2>$null, >nul).
  const withoutSafeRedirects = cmd.replace(/\d?>&\d|\d?>\s*(\/dev\/null|\$null|nul)\b/gi, "");
  if (/[^-=]>/.test(withoutSafeRedirects)) return false;
  if (/\$\(|`/.test(cmd) && /\b(rm|mv|cp|del|Remove-Item)\b/.test(cmd)) return false;

  const segments = cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  const lowerAllow = allow.map((a) => a.toLowerCase());
  return segments.every((seg) => {
    const words = seg.replace(/^\(|\)$/g, "").split(/\s+/);
    // Skip leading env assignments (FOO=bar cmd) and wrappers (timeout 60 cmd, time cmd).
    for (;;) {
      const w = words[0];
      if (w === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === "time" || w === "nice" || w === "command") words.shift();
      else if (w === "timeout") words.splice(0, /^\d/.test(words[1] ?? "") ? 2 : 1);
      else break;
    }
    if (!words.length) return true;
    const first = words[0]!.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
    // Stream editors are read-only unless editing in place.
    if (first === "sed" || first === "perl") return !words.some((w) => /^-i|^--in-place/.test(w));
    const two = `${first} ${(words[1] ?? "").toLowerCase()}`;
    const three = `${two} ${(words[2] ?? "").toLowerCase()}`;
    // git -C <dir> <sub>: drop the -C pair
    if (first === "git" && words[1] === "-C") {
      const sub = `git ${(words[3] ?? "").toLowerCase()}`;
      return lowerAllow.includes(sub);
    }
    return lowerAllow.includes(first) || lowerAllow.includes(two) || lowerAllow.includes(three);
  });
}

function pathNeedles(p: string | undefined): string[] {
  if (!p) return [];
  const norm = normalizePath(p);
  const base = norm.split("/").pop() ?? norm;
  return base.length >= 4 && base !== norm ? [norm, base] : [norm];
}

/** Path-like or identifier-like tokens from a shell command. */
function commandNeedles(command: string): string[] {
  const tokens = command.match(/[\w.\-\\/:~]+/g) ?? [];
  const out = new Set<string>();
  for (const t of tokens) {
    const tok = t.replace(/^['"]|['"]$/g, "");
    const looksLikePath = /[\\/]/.test(tok) || /\.\w{1,5}$/.test(tok);
    if (looksLikePath && tok.length >= 5) {
      const n = normalizePath(tok);
      out.add(n);
      const base = n.split("/").pop();
      if (base && base.length >= 5) out.add(base);
    }
  }
  return [...out];
}

function genericSummary(inp: Input): string {
  for (const v of Object.values(inp)) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

export function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
