// What the CLI hands the report page. Pure — shared by the CLI and the page.
//
// The report is one self-contained HTML file. It embeds a ReportIndex (one SessionRow per
// session) and each session's full data, as JSON script elements the page parses on demand.

import type { Cost } from "./cost.js";
import { type DailyCost, type SessionAnalysis, type SlowCall, type ToolStat, type Ttl, costByDay } from "./metrics.js";
import { isMeaningfulPrompt } from "./records.js";
import type { Session, SessionInfo } from "./types.js";

export const REPORT_VERSION = 4;
export const INDEX_ELEMENT_ID = "session-index";
export const INDEX_PLACEHOLDER = `<script id="${INDEX_ELEMENT_ID}" type="application/json"></script>`;
/** Attribute naming the session (its key) on each session's JSON script element. */
export const SESSION_ATTR = "data-session";
/** Follows the last data element, so the dev server can lift the data out of a generated report. */
export const DATA_END = "<!--/session-data-->";

export interface SessionRow {
  /** Unique and attribute-safe: `<projectDir>__<id>`. Names the session's data element. */
  key: string;
  id: string;
  projectDir: string;
  /** The project's working directory. */
  project: string;
  title?: string;
  firstPrompt?: string;
  startedAt: number;
  endedAt: number;
  /** Size of the main log file, in bytes. */
  size: number;
  prompts: number;
  turns: number;
  toolCalls: number;
  subagents: number;
  activeMs: number;
  /** Time spent waiting on your answers (AskUserQuestion, plan approval); not in `activeMs`. */
  waitMs: number;
  modelMs: number;
  toolMs: number;
  cost: Cost;
  costByModel: Record<string, number>;
  /** Cost per local day (the generating machine's time zone) and model. */
  costByDay: DailyCost;
  unpricedTurns: number;
  peakContext: number;
  misses: number;
  missCost: number;
  expiries: number;
  expiryCost: number;
  ttl: Ttl;
  byTool: Record<string, ToolStat>;
  slowest: SlowCall[];
}

export interface ReportIndex {
  version: number;
  generatedAt: number;
  /** Sessions active in the last N days; 0 = all. */
  sinceDays: number;
  projectFilter?: string;
  sessions: SessionRow[];
  /** Sessions that couldn't be read. */
  failed: { path: string; error: string }[];
}

export const sessionKey = (projectDir: string, id: string) => `${projectDir}__${id}`.replace(/[^A-Za-z0-9._-]/g, "_");

const FIRST_PROMPT_CAP = 600;
const SLOWEST_IN_ROW = 5;

export function sessionRow(s: Session, info: SessionInfo, a: SessionAnalysis): SessionRow {
  const t = a.total;
  const expired = t.misses.filter((m) => m.kind === "expired");
  const first = s.prompts.find(isMeaningfulPrompt)?.text ?? info.firstPrompt;
  return {
    key: sessionKey(s.projectDir, s.id),
    id: s.id,
    projectDir: s.projectDir,
    project: info.cwd ?? s.cwd,
    title: s.title ?? info.title,
    firstPrompt: first && first.length > FIRST_PROMPT_CAP ? `${first.slice(0, FIRST_PROMPT_CAP)}…` : first,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    size: info.size,
    prompts: s.prompts.length,
    turns: t.turns,
    toolCalls: t.toolCalls,
    subagents: t.subagents,
    activeMs: t.activeMs,
    waitMs: t.waitMs,
    modelMs: t.modelMs,
    toolMs: t.toolMs,
    cost: t.cost,
    costByModel: Object.fromEntries(Object.entries(t.byModel).filter(([, m]) => m.cost > 0).map(([k, m]) => [k, m.cost])),
    costByDay: costByDay(s),
    unpricedTurns: t.unpricedTurns,
    peakContext: t.peakContext,
    misses: t.misses.length,
    missCost: t.missCost,
    expiries: expired.length,
    expiryCost: expired.reduce((sum, m) => sum + m.cost, 0),
    ttl: t.ttl,
    byTool: t.byTool,
    slowest: t.slowest.slice(0, SLOWEST_IN_ROW),
  };
}

/** JSON that can sit inside a <script> element: `<` can't close it once escaped. */
export const scriptSafeJson = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");

/** The data elements that replace INDEX_PLACEHOLDER: the index, then one element per session. */
export function dataElements(index: ReportIndex, sessions: Map<string, Session>): string {
  const parts = [`<script id="${INDEX_ELEMENT_ID}" type="application/json">${scriptSafeJson(index)}</script>`];
  for (const [key, session] of sessions) parts.push(`<script type="application/json" ${SESSION_ATTR}="${key}">${scriptSafeJson(session)}</script>`);
  parts.push(DATA_END);
  return parts.join("\n");
}

/** Budget for the tool input previews of the whole report; reports with many calls get shorter previews. */
const PREVIEW_BUDGET = 48_000_000;
const MIN_PREVIEW = 300;

const MORE = /\n… ([\d,]+) more characters$/;

/** Cap an already-capped preview again, keeping the count of what was cut. */
function recap(text: string, max: number): string {
  if (text.length <= max) return text;
  const m = MORE.exec(text);
  const body = m ? text.slice(0, m.index) : text;
  // Only the note pushes it over: keep it as is, note included.
  if (body.length <= max) return text;
  const full = body.length + (m ? Number(m[1]!.replaceAll(",", "")) : 0);
  return `${body.slice(0, max)}\n… ${(full - max).toLocaleString("en-US")} more characters`;
}

/** Shorten tool input previews in place so the report stays loadable. */
export function trimPreviews(sessions: Iterable<Session>): void {
  const calls: { input: string }[] = [];
  const walk = (o: unknown) => {
    if (Array.isArray(o)) for (const x of o) walk(x);
    else if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      if (typeof r.category === "string" && typeof r.input === "string") calls.push(r as unknown as { input: string });
      for (const v of Object.values(r)) if (v && typeof v === "object") walk(v);
    }
  };
  for (const s of sessions) walk(s.prompts);
  const max = Math.max(MIN_PREVIEW, Math.floor(PREVIEW_BUDGET / (calls.length || 1)));
  for (const c of calls) c.input = recap(c.input, max);
}
