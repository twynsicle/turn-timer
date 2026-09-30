import type { RunTotals, Stats } from "../../src/core/metrics.js";
import type { ProjectInfo, Session, SessionInfo, ToolCall } from "../../src/core/types.js";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? res.statusText);
  return body as T;
}

const enc = encodeURIComponent;

export type SlimStats = Omit<Stats, "runs"> & { runTotals: RunTotals };

export type SessionRow = SessionInfo & { startedAt: number; endedAt: number; prompts: number; reminders: number; stats: SlimStats };

export interface ProjectStats {
  total: SlimStats;
  sessions: SessionRow[];
}

export interface TopSessions {
  total: SlimStats;
  /** Sorted by estimated cost, most expensive first. */
  sessions: (SessionRow & { project: string })[];
}

export interface Detail {
  input: unknown;
  result?: { text: string; truncated: boolean; isError: boolean };
}

export const api = {
  projects: () => get<ProjectInfo[]>("/api/projects"),
  sessions: (project: string) => get<SessionInfo[]>(`/api/projects/${enc(project)}/sessions`),
  projectStats: (project: string, subagents: boolean, sinceDays = 0) =>
    get<ProjectStats>(`/api/projects/${enc(project)}/stats?subagents=${subagents}&sinceDays=${sinceDays}`),
  top: (subagents: boolean, sinceDays: number) => get<TopSessions>(`/api/top?subagents=${subagents}&sinceDays=${sinceDays}`),
  session: (project: string, id: string) => get<Session>(`/api/sessions/${enc(project)}/${enc(id)}`),
  detail: (project: string, id: string, c: ToolCall) =>
    get<Detail>(
      `/api/sessions/${enc(project)}/${enc(id)}/detail?file=${c.file}&offset=${c.offset}&id=${enc(c.id)}` +
        (c.resultOffset !== undefined ? `&resultOffset=${c.resultOffset}` : ""),
    ),
};
