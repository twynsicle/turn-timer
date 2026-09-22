// Metrics over the session model. Pure (no Node imports) — shared with the web viewer.

import type { AgentRef, Prompt, Session, ToolCall, Turn } from "./types.js";

export interface MetricOptions {
  /** Include subagent turns (default true). */
  subagents?: boolean;
}

export const BUCKETS = ["1", "2", "3", "4-5", "6-10", "11+"] as const;

export function bucketOf(n: number): number {
  if (n <= 3) return n - 1;
  if (n <= 5) return 3;
  if (n <= 10) return 4;
  return 5;
}

export type RunKind = "likely" | "possibly";

export interface BatchableRun {
  kind: RunKind;
  agent: AgentRef;
  promptIndex: number;
  /** Message ids of the turns in the run, in order. */
  turnIds: string[];
  tools: string[];
  /** Round-trips that batching would have saved (run length - 1). */
  savedTurns: number;
  /** Model latency of the turns after the first — the time batching would have saved. */
  savedMs: number;
}

export interface ToolStat {
  calls: number;
  /** Turns where this tool was the only call. */
  soloTurns: number;
}

export interface Stats {
  turns: number;
  /** Turns containing at least one tool call. */
  toolTurns: number;
  toolCalls: number;
  singleCallTurns: number;
  histogram: number[];
  maxBatch: number;
  avgBatch: number;
  medianBatch: number;
  /** Sum of model response time across turns. */
  modelMs: number;
  /** Sum of tool execution spans across turns. */
  toolMs: number;
  runs: BatchableRun[];
  savedTurns: number;
  savedMs: number;
  byTool: Record<string, ToolStat>;
}

export const turnModelMs = (t: Turn) => Math.max(0, t.respondedAt - t.requestedAt);

export function turnToolMs(t: Turn): number {
  let start = Infinity;
  let end = 0;
  for (const c of t.toolCalls) {
    start = Math.min(start, c.startedAt);
    if (c.finishedAt) end = Math.max(end, c.finishedAt);
  }
  return end > start ? end - start : 0;
}

/** Turn sequences per agent: the main thread first, then each subagent (depth-first). */
export function agentStreams(turns: Turn[], opts: MetricOptions = {}): Turn[][] {
  const out: Turn[][] = [turns];
  if (opts.subagents === false) return out;
  const visit = (ts: Turn[]) => {
    for (const t of ts) {
      for (const c of t.toolCalls) {
        if (c.subagent) {
          out.push(c.subagent.turns);
          visit(c.subagent.turns);
        }
      }
    }
  };
  visit(turns);
  return out;
}

export function promptStreams(p: Prompt, opts: MetricOptions = {}): Turn[][] {
  return agentStreams(p.turns, opts);
}

const isBatchable = (c: ToolCall) => c.readOnly || c.category === "edit";

/**
 * Find runs of consecutive single-call turns within one agent stream that could have
 * been a single batched turn.
 *
 * A run extends while each next call is read-only or an edit, doesn't touch a path
 * already touched in the run, and doesn't reference a result produced inside the run.
 * Runs of only read-only calls are "likely"; runs that include edits are "possibly".
 */
export function findRuns(turns: Turn[], promptIndex: number): BatchableRun[] {
  const runs: BatchableRun[] = [];
  let run: Turn[] = [];
  let paths = new Set<string>();

  const close = () => {
    if (run.length >= 2) {
      const calls = run.map((t) => t.toolCalls[0]!);
      runs.push({
        kind: calls.every((c) => c.readOnly) ? "likely" : "possibly",
        agent: run[0]!.agent,
        promptIndex,
        turnIds: run.map((t) => t.messageId),
        tools: calls.map((c) => c.name),
        savedTurns: run.length - 1,
        savedMs: run.slice(1).reduce((s, t) => s + turnModelMs(t), 0),
      });
    }
    run = [];
    paths = new Set();
  };
  const start = (t: Turn) => {
    run = [t];
    paths = new Set(t.toolCalls[0]!.paths);
  };

  for (const t of turns) {
    const c = t.toolCalls.length === 1 ? t.toolCalls[0]! : undefined;
    if (!c || !isBatchable(c) || c.denied) {
      close();
      continue;
    }
    if (!run.length) {
      start(t);
      continue;
    }
    const dependsOnRun = c.refsBack > 0 && c.refsBack <= run.length;
    const overlaps = c.paths.some((p) => paths.has(p));
    if (dependsOnRun || overlaps) {
      close();
      start(t);
      continue;
    }
    run.push(t);
    for (const p of c.paths) paths.add(p);
  }
  close();
  return runs;
}

/** Stats over a set of agent streams (runs are detected per stream). */
export function computeStats(streams: { turns: Turn[]; promptIndex: number }[]): Stats {
  const batches: number[] = [];
  const histogram = BUCKETS.map(() => 0);
  const byTool: Record<string, ToolStat> = {};
  let turns = 0;
  let toolCalls = 0;
  let modelMs = 0;
  let toolMs = 0;
  const runs: BatchableRun[] = [];

  for (const s of streams) {
    for (const t of s.turns) {
      turns++;
      modelMs += turnModelMs(t);
      const n = t.toolCalls.length;
      if (!n) continue;
      toolMs += turnToolMs(t);
      batches.push(n);
      toolCalls += n;
      histogram[bucketOf(n)]!++;
      for (const c of t.toolCalls) {
        const ts = (byTool[c.name] ??= { calls: 0, soloTurns: 0 });
        ts.calls++;
        if (n === 1) ts.soloTurns++;
      }
    }
    runs.push(...findRuns(s.turns, s.promptIndex));
  }
  batches.sort((a, b) => a - b);
  return {
    turns,
    toolTurns: batches.length,
    toolCalls,
    singleCallTurns: histogram[0]!,
    histogram,
    maxBatch: batches.at(-1) ?? 0,
    avgBatch: batches.length ? toolCalls / batches.length : 0,
    medianBatch: batches.length ? batches[Math.floor(batches.length / 2)]! : 0,
    modelMs,
    toolMs,
    runs,
    savedTurns: runs.reduce((s, r) => s + r.savedTurns, 0),
    savedMs: runs.reduce((s, r) => s + r.savedMs, 0),
    byTool,
  };
}

export function promptStats(p: Prompt, opts: MetricOptions = {}): Stats {
  return computeStats(promptStreams(p, opts).map((turns) => ({ turns, promptIndex: p.index })));
}

export function sessionStats(s: Session, opts: MetricOptions = {}): Stats {
  return computeStats(
    s.prompts.flatMap((p) => promptStreams(p, opts).map((turns) => ({ turns, promptIndex: p.index }))),
  );
}

/** Combine already-computed stats (e.g. across sessions of a project). */
export function mergeStats(parts: Stats[]): Stats {
  const histogram = BUCKETS.map((_, i) => parts.reduce((s, p) => s + p.histogram[i]!, 0));
  const byTool: Record<string, ToolStat> = {};
  for (const p of parts) {
    for (const [name, t] of Object.entries(p.byTool)) {
      const acc = (byTool[name] ??= { calls: 0, soloTurns: 0 });
      acc.calls += t.calls;
      acc.soloTurns += t.soloTurns;
    }
  }
  const sum = (k: "turns" | "toolTurns" | "toolCalls" | "modelMs" | "toolMs" | "savedTurns" | "savedMs") =>
    parts.reduce((s, p) => s + p[k], 0);
  const toolTurns = sum("toolTurns");
  const toolCalls = sum("toolCalls");
  // Median from the histogram is approximate across parts; use the bucket's lower bound.
  let median = 0;
  let seen = 0;
  const lower = [1, 2, 3, 4, 6, 11];
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i]!;
    if (seen > toolTurns / 2) {
      median = lower[i]!;
      break;
    }
  }
  return {
    turns: sum("turns"),
    toolTurns,
    toolCalls,
    singleCallTurns: histogram[0]!,
    histogram,
    maxBatch: Math.max(0, ...parts.map((p) => p.maxBatch)),
    avgBatch: toolTurns ? toolCalls / toolTurns : 0,
    medianBatch: median,
    modelMs: sum("modelMs"),
    toolMs: sum("toolMs"),
    runs: parts.flatMap((p) => p.runs),
    savedTurns: sum("savedTurns"),
    savedMs: sum("savedMs"),
    byTool,
  };
}

/** Every turn in the prompt, main thread plus (optionally) subagents, in stream order. */
export function allTurns(p: Prompt, opts: MetricOptions = {}): Turn[] {
  return promptStreams(p, opts).flat();
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m${String(secs % 60).padStart(2, "0")}s`;
  const mins = Math.round(secs / 60);
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}

export function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "–";
}
