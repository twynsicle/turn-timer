// Metrics over the session model. Pure (no Node imports) — shared with the report.

import { type Cost, type Tokens, addCost, addTokens, contextTokens, rebuildCost, turnCost, usageTokens, zeroCost, zeroTokens } from "./cost.js";
import type { AgentRef, Prompt, Session, SubagentRun, ToolCall, Turn } from "./types.js";

export interface ModelStat {
  turns: number;
  tokens: Tokens;
  /** 0 when the model has no known price. */
  cost: number;
  priced: boolean;
}

export interface ToolStat {
  calls: number;
  errors: number;
  /** Sum of the calls' run times. */
  totalMs: number;
  maxMs: number;
}

/**
 * Why a turn had to rewrite context that the previous turn had cached:
 * - expired: longer than the cache TTL since the previous request started
 * - model-switch: the cache belongs to one model; a new model starts cold
 * - invalidated: within the TTL on the same model; something earlier in the prompt changed
 */
export type MissKind = "expired" | "model-switch" | "invalidated";

export interface CacheMiss {
  kind: MissKind;
  messageId: string;
  promptIndex: number;
  agent: AgentRef;
  /** From the previous request's start to this one's. */
  gapMs: number;
  /** The cache TTL in effect, from the stream's latest cache write (5 minutes when unknown). */
  ttlMs: number;
  /** Tokens that were cached before and had to be written again. */
  rebuiltTokens: number;
  /** Extra cost over reading them from the cache. */
  cost: number;
  model: string;
  prevModel: string;
}

export interface SlowCall {
  id: string;
  name: string;
  summary: string;
  ms: number;
  promptIndex: number;
  /** Set for calls a subagent made. */
  agentType?: string;
  isError: boolean;
}

export type Ttl = "5m" | "1h" | "mixed" | "none";

export interface Stats {
  turns: number;
  toolCalls: number;
  subagents: number;
  /** Main-thread model response time. */
  modelMs: number;
  /** Main-thread tool time. Subagents run inside the Agent call that started them. */
  toolMs: number;
  /** Time Claude spent working on prompts: prompt to last activity, idle time excluded. */
  activeMs: number;
  tokens: Tokens;
  /** Estimated cost at API list prices; excludes turns whose model has no known price. */
  cost: Cost;
  /** Turns whose model has no known price (not in `cost`). */
  unpricedTurns: number;
  /** Largest context (input + cache read + cache write) any single turn read. */
  peakContext: number;
  byModel: Record<string, ModelStat>;
  misses: CacheMiss[];
  missCost: number;
  /** Cache TTL of the main thread's writes. */
  ttl: Ttl;
  byTool: Record<string, ToolStat>;
  /** The slowest tool calls, slowest first. */
  slowest: SlowCall[];
}

export const SLOWEST_KEPT = 25;

export const turnModelMs = (t: Turn) => Math.max(0, t.respondedAt - t.requestedAt);

export const callMs = (c: ToolCall) => (c.finishedAt ? Math.max(0, c.finishedAt - c.startedAt) : 0);

/** Wall time the turn's tools ran for (parallel calls overlap). */
export function turnToolMs(t: Turn): number {
  let start = Infinity;
  let end = 0;
  for (const c of t.toolCalls) {
    start = Math.min(start, c.startedAt);
    if (c.finishedAt) end = Math.max(end, c.finishedAt);
  }
  return end > start ? end - start : 0;
}

export interface Stream {
  turns: Turn[];
  promptIndex: number;
  main: boolean;
}

function subagentStreams(turns: Turn[], promptIndex: number, out: Stream[]) {
  for (const t of turns) {
    for (const c of t.toolCalls) {
      if (!c.subagent) continue;
      out.push({ turns: c.subagent.turns, promptIndex, main: false });
      subagentStreams(c.subagent.turns, promptIndex, out);
    }
  }
}

/** The prompt's main thread, then every subagent under it (depth-first), then detached runs. */
export function promptStreams(p: Prompt): Stream[] {
  const out: Stream[] = [{ turns: p.turns, promptIndex: p.index, main: true }];
  subagentStreams(p.turns, p.index, out);
  for (const r of p.detached ?? []) out.push(...runStreams(r, p.index));
  return out;
}

export function runStreams(run: SubagentRun, promptIndex: number): Stream[] {
  const out: Stream[] = [{ turns: run.turns, promptIndex, main: false }];
  subagentStreams(run.turns, promptIndex, out);
  return out;
}

function lastActivity(streams: Stream[], from: number): number {
  let end = from;
  for (const s of streams) {
    for (const t of s.turns) {
      end = Math.max(end, t.respondedAt);
      for (const c of t.toolCalls) if (c.finishedAt) end = Math.max(end, c.finishedAt);
    }
  }
  return end;
}

/** When the prompt's last activity ended, in any stream. */
export const promptEnd = (p: Prompt) => lastActivity(promptStreams(p), p.startedAt);

/** How long a subagent ran: its first request to its (or its children's) last activity. */
export function runSpanMs(run: SubagentRun): number {
  const start = run.turns[0]?.requestedAt;
  return start ? lastActivity(runStreams(run, -1), start) - start : 0;
}

export const promptActiveMs = (p: Prompt) => (p.turns.length || p.detached?.length ? promptEnd(p) - p.startedAt : 0);

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
/** Rebuilds smaller than this aren't worth reporting. */
const MIN_MISS_TOKENS = 5000;

/**
 * Turns that rewrote context the previous turn in the same stream had cached. The main thread
 * is scanned across prompts, since the usual miss is the first turn after you've been away.
 *
 * A miss: this turn read less than 80% of the previous turn's context from the cache, lost at
 * least MIN_MISS_TOKENS, and wrote back at least half of what it lost. The last condition
 * separates a rebuild from compaction, where the context shrinks instead.
 */
export function findCacheMisses(s: Session): CacheMiss[] {
  const out: CacheMiss[] = [];
  scanStream(s.prompts.flatMap((p) => p.turns.map((t) => ({ t, promptIndex: p.index }))), out);
  for (const p of s.prompts) {
    for (const st of promptStreams(p).slice(1)) scanStream(st.turns.map((t) => ({ t, promptIndex: p.index })), out);
  }
  return out;
}

function scanStream(items: { t: Turn; promptIndex: number }[], out: CacheMiss[]) {
  let ttlMs = 0;
  for (let i = 0; i < items.length; i++) {
    const { t, promptIndex } = items[i]!;
    const prev = items[i - 1]?.t;
    if (prev) {
      const expected = contextTokens(prev.usage);
      const lost = expected - t.usage.cacheRead;
      const rewritten = t.usage.input + t.usage.cacheWrite5m + t.usage.cacheWrite1h;
      if (lost >= MIN_MISS_TOKENS && t.usage.cacheRead < expected * 0.8 && rewritten >= lost * 0.5) {
        const rebuilt = Math.min(lost, rewritten);
        const gapMs = Math.max(0, t.requestedAt - prev.requestedAt);
        const ttl = ttlMs || FIVE_MINUTES;
        out.push({
          kind: t.model !== prev.model ? "model-switch" : gapMs > ttl ? "expired" : "invalidated",
          messageId: t.messageId,
          promptIndex,
          agent: t.agent,
          gapMs,
          ttlMs: ttl,
          rebuiltTokens: rebuilt,
          cost: rebuildCost(t, rebuilt),
          model: t.model,
          prevModel: prev.model,
        });
      }
    }
    if (t.usage.cacheWrite1h > 0) ttlMs = ONE_HOUR;
    else if (t.usage.cacheWrite5m > 0) ttlMs = FIVE_MINUTES;
  }
}

class StatsBuilder {
  turns = 0;
  toolCalls = 0;
  subagents = 0;
  modelMs = 0;
  toolMs = 0;
  activeMs = 0;
  tokens = zeroTokens();
  cost = zeroCost();
  unpricedTurns = 0;
  peakContext = 0;
  byModel: Record<string, ModelStat> = {};
  misses: CacheMiss[] = [];
  byTool: Record<string, ToolStat> = {};
  slowest: SlowCall[] = [];
  ttl5m = false;
  ttl1h = false;

  addStream(s: Stream) {
    if (!s.main) this.subagents++;
    for (const t of s.turns) this.addTurn(t, s);
  }

  private addTurn(t: Turn, s: Stream) {
    this.turns++;
    const tt = usageTokens(t.usage);
    addTokens(this.tokens, tt);
    this.peakContext = Math.max(this.peakContext, contextTokens(t.usage));
    const c = turnCost(t);
    if (c) addCost(this.cost, c);
    else this.unpricedTurns++;
    const ms = (this.byModel[t.model || "unknown"] ??= { turns: 0, tokens: zeroTokens(), cost: 0, priced: !!c });
    ms.turns++;
    addTokens(ms.tokens, tt);
    ms.cost += c?.total ?? 0;
    if (s.main) {
      this.modelMs += turnModelMs(t);
      this.toolMs += turnToolMs(t);
      if (t.usage.cacheWrite1h > 0) this.ttl1h = true;
      else if (t.usage.cacheWrite5m > 0) this.ttl5m = true;
    }
    for (const call of t.toolCalls) {
      this.toolCalls++;
      const d = callMs(call);
      const ts = (this.byTool[call.name] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0 });
      ts.calls++;
      if (call.isError) ts.errors++;
      ts.totalMs += d;
      ts.maxMs = Math.max(ts.maxMs, d);
      if (d > 0) this.considerSlow(call, d, t, s.promptIndex);
    }
  }

  private considerSlow(c: ToolCall, ms: number, t: Turn, promptIndex: number) {
    const list = this.slowest;
    if (list.length >= SLOWEST_KEPT && ms <= list.at(-1)!.ms) return;
    list.push({
      id: c.id,
      name: c.name,
      summary: c.summary,
      ms,
      promptIndex,
      agentType: t.agent.kind === "subagent" ? t.agent.agentType : undefined,
      isError: c.isError,
    });
    list.sort((a, b) => b.ms - a.ms);
    if (list.length > SLOWEST_KEPT) list.pop();
  }

  build(): Stats {
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      subagents: this.subagents,
      modelMs: this.modelMs,
      toolMs: this.toolMs,
      activeMs: this.activeMs,
      tokens: this.tokens,
      cost: this.cost,
      unpricedTurns: this.unpricedTurns,
      peakContext: this.peakContext,
      byModel: this.byModel,
      misses: this.misses,
      missCost: this.misses.reduce((sum, m) => sum + m.cost, 0),
      ttl: this.ttl1h && this.ttl5m ? "mixed" : this.ttl1h ? "1h" : this.ttl5m ? "5m" : "none",
      byTool: this.byTool,
      slowest: this.slowest,
    };
  }
}

export interface SessionAnalysis {
  total: Stats;
  /** One per prompt, by prompt index. */
  prompts: Stats[];
  /** Cache misses by the message id of the turn that rebuilt the cache. */
  missByTurn: Map<string, CacheMiss>;
}

export function analyzeSession(s: Session): SessionAnalysis {
  const misses = findCacheMisses(s);
  const missByTurn = new Map(misses.map((m) => [m.messageId, m]));
  const total = new StatsBuilder();
  total.misses = misses;
  const spans: [number, number][] = [];
  const prompts = s.prompts.map((p) => {
    const b = new StatsBuilder();
    b.activeMs = promptActiveMs(p);
    b.misses = misses.filter((m) => m.promptIndex === p.index);
    for (const st of promptStreams(p)) {
      b.addStream(st);
      total.addStream(st);
    }
    if (b.activeMs) spans.push([p.startedAt, p.startedAt + b.activeMs]);
    return b.build();
  });
  // A background subagent can keep a prompt running into the next one: count that time once.
  total.activeMs = unionMs(spans);
  return { total: total.build(), prompts, missByTurn };
}

/** Total length of a set of time ranges, overlaps counted once. */
function unionMs(spans: [number, number][]): number {
  let sum = 0;
  let end = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    sum += b - Math.max(a, end);
    end = b;
  }
  return sum;
}

/** Stats for one subagent run and everything it spawned. */
export function runStats(run: SubagentRun, missByTurn: Map<string, CacheMiss>): Stats {
  const b = new StatsBuilder();
  for (const st of runStreams(run, -1)) {
    b.addStream(st);
    for (const t of st.turns) {
      const m = missByTurn.get(t.messageId);
      if (m) b.misses.push(m);
    }
  }
  return b.build();
}

/** Cost per model on each day: `{ "2026-09-29": { "claude-opus-5": 12.5 } }`. */
export type DailyCost = Record<string, Record<string, number>>;

/** The local calendar day, as "2026-09-29". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Each turn's cost on the day it was requested, subagents included. */
export function costByDay(s: Session): DailyCost {
  const out: DailyCost = {};
  for (const p of s.prompts) {
    for (const stream of promptStreams(p)) {
      for (const t of stream.turns) {
        const c = turnCost(t)?.total;
        if (!c) continue;
        const day = (out[dayKey(t.requestedAt || t.respondedAt)] ??= {});
        day[t.model || "unknown"] = (day[t.model || "unknown"] ?? 0) + c;
      }
    }
  }
  return out;
}

export function addDaily(into: DailyCost, from: DailyCost): DailyCost {
  for (const [day, models] of Object.entries(from)) {
    const d = (into[day] ??= {});
    for (const [m, c] of Object.entries(models)) d[m] = (d[m] ?? 0) + c;
  }
  return into;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${String(secs % 60).padStart(2, "0")}s`;
  const mins = Math.round(secs / 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

export function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : "–";
}
