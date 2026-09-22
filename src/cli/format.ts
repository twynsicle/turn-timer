import pc from "picocolors";
import { BUCKETS, formatMs, pct, type Stats } from "../core/metrics.js";

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLength = (s: string) => s.replace(ANSI, "").length;

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

export interface Column {
  header: string;
  align?: "left" | "right";
  /** Max width; the column shrinks to fit the terminal if needed (only one flex column). */
  flex?: boolean;
}

export function table(columns: Column[], rows: string[][]): string {
  const termWidth = process.stdout.columns || 120;
  const widths = columns.map((c, i) => Math.max(visibleLength(c.header), ...rows.map((r) => visibleLength(r[i] ?? ""))));
  const gap = 2;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1);
  const flexIdx = columns.findIndex((c) => c.flex);
  if (total > termWidth && flexIdx >= 0) {
    widths[flexIdx] = Math.max(12, widths[flexIdx]! - (total - termWidth));
  }
  const cell = (s: string, i: number) => {
    const w = widths[i]!;
    let text = s;
    if (visibleLength(text) > w) text = truncate(text.replace(ANSI, ""), w);
    const padLen = w - visibleLength(text);
    return columns[i]!.align === "right" ? " ".repeat(padLen) + text : text + " ".repeat(padLen);
  };
  const lines = [columns.map((c, i) => pc.dim(cell(c.header, i))).join(" ".repeat(gap))];
  for (const r of rows) lines.push(columns.map((_, i) => cell(r[i] ?? "", i)).join(" ".repeat(gap)).trimEnd());
  return lines.join("\n");
}

export function date(ms: number | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1 << 20) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1 << 20)).toFixed(1)}MB`;
}

/** Colour a single-call percentage: lower is better. */
export function singlePct(single: number, total: number): string {
  const s = pct(single, total);
  if (!total) return pc.dim(s);
  const r = single / total;
  return r >= 0.5 ? pc.red(s) : r >= 0.3 ? pc.yellow(s) : pc.green(s);
}

export function histogram(st: Stats): string {
  const max = Math.max(1, ...st.histogram);
  const width = 30;
  return BUCKETS.map((b, i) => {
    const n = st.histogram[i]!;
    const bar = "█".repeat(Math.round((n / max) * width)) || (n ? "▏" : "");
    const label = b.padStart(5);
    return `  ${pc.dim(label)} ${i === 0 ? pc.red(bar) : pc.cyan(bar)} ${n} ${pc.dim(`(${pct(n, st.toolTurns)})`)}`;
  }).join("\n");
}

export function summary(st: Stats, extra: { prompts?: number; reminders?: number } = {}): string {
  const likely = st.runs.filter((r) => r.kind === "likely");
  const possibly = st.runs.filter((r) => r.kind === "possibly");
  const sum = (rs: typeof likely, k: "savedTurns" | "savedMs") => rs.reduce((s, r) => s + r[k], 0);
  const lines = [
    [
      extra.prompts !== undefined ? `${pc.bold(String(extra.prompts))} prompts` : "",
      `${pc.bold(String(st.turns))} turns`,
      `${pc.bold(String(st.toolCalls))} tool calls`,
      `avg batch ${pc.bold(st.avgBatch.toFixed(2))}`,
      `median ${st.medianBatch}`,
      `max ${st.maxBatch}`,
    ]
      .filter(Boolean)
      .join(pc.dim(" · ")),
    `single-call turns: ${singlePct(st.singleCallTurns, st.toolTurns)} ${pc.dim(`(${st.singleCallTurns} of ${st.toolTurns} tool turns)`)}`,
    `batchable runs: ${pc.red(`${likely.length} likely`)} ${pc.dim(`(${sum(likely, "savedTurns")} round-trips, ~${formatMs(sum(likely, "savedMs"))})`)}` +
      `  ${pc.yellow(`${possibly.length} possibly`)} ${pc.dim(`(${sum(possibly, "savedTurns")} round-trips, ~${formatMs(sum(possibly, "savedMs"))})`)}`,
    `time: model ${formatMs(st.modelMs)} · tools ${formatMs(st.toolMs)}` +
      (extra.reminders ? pc.dim(` · Claude Code sent ${extra.reminders} batching reminders`) : ""),
  ];
  return lines.join("\n");
}
