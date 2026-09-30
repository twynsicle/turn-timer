import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo, Session, SessionInfo } from "../../src/core/types.js";
import { api, type ProjectStats, type SessionRow, type TopSessions } from "./api.js";
import {
  Caption,
  CostPanel,
  type DetailTarget,
  DetailDrawer,
  Histogram,
  SectionRule,
  Stats,
  ToolsTable,
  fmtDate,
  fmtSize,
  formatMs,
  formatTokens,
  formatUsd,
  pct,
  singleClass,
} from "./common.js";
import { SessionView } from "./SessionView.js";

interface Route {
  project?: string;
  session?: string;
}

const readRoute = (): Route => {
  const [project, session] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  return { project: project || undefined, session: session || undefined };
};

const writeRoute = (r: Route) => {
  const hash = r.project ? `#/${encodeURIComponent(r.project)}${r.session ? `/${encodeURIComponent(r.session)}` : ""}` : "";
  if (location.hash !== hash) history.pushState(null, "", hash || location.pathname);
};

function usePersisted(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : s === "true";
    } catch {
      return initial;
    }
  });
  const set = (nv: boolean) => {
    setV(nv);
    try {
      localStorage.setItem(key, String(nv));
    } catch {
      // ignore
    }
  };
  return [v, set];
}

const projectName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subagents, setSubagents] = usePersisted("tt.subagents", true);
  const [filter, setFilter] = useState("");
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const navigate = useCallback((r: Route) => {
    writeRoute(r);
    setRoute(r);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setError(e.message));
  }, []);

  // The sidebar lists the current project's sessions; on the all-projects page, the last
  // project viewed (or the most recently active one).
  const [lastProject, setLastProject] = useState<string | undefined>(route.project);
  useEffect(() => {
    if (route.project) setLastProject(route.project);
  }, [route.project]);
  const sideProject = route.project ?? lastProject ?? projects?.[0]?.dir;

  useEffect(() => {
    setSessions(null);
    setFilter("");
    if (!sideProject) return;
    api.sessions(sideProject).then(setSessions, (e: Error) => setError(e.message));
  }, [sideProject]);

  useEffect(() => {
    setSession(null);
    setDetail(null);
    if (!route.project || !route.session) return;
    let live = true;
    const info = sessions?.find((s) => s.id === route.session);
    setLoading(`Parsing session${info ? ` (${fmtSize(info.size)})` : ""}…`);
    setError(null);
    api
      .session(route.project, route.session)
      .then((s) => live && setSession(s))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.project, route.session]);

  const project = projects?.find((p) => p.dir === route.project);
  const sidebarProject = projects?.find((p) => p.dir === sideProject);
  const shown = sessions?.filter((s) => {
    if (!filter) return true;
    const hay = `${s.id} ${s.title ?? ""} ${s.firstPrompt ?? ""}`.toLowerCase();
    return hay.includes(filter.toLowerCase());
  });

  return (
    <div className={`shell ${detail ? "with-drawer" : ""}`}>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            turn-timer
          </span>
          <label className="project-picker">
            <span className="sr-only">Project</span>
            <select value={sideProject ?? ""} onChange={(e) => navigate({ project: e.target.value })}>
              {!projects && <option>Loading…</option>}
              {projects?.map((p) => (
                <option key={p.dir} value={p.dir}>
                  {projectName(p.cwd)} ({p.sessionCount})
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={subagents} onChange={(e) => setSubagents(e.target.checked)} />
            Include subagents
          </label>
        </div>
      </header>

      <div className="layout">
        <aside className="nav">
          <button className={`nav-card ${!route.project ? "active" : ""}`} onClick={() => navigate({})}>
            <Caption>All projects</Caption>
            <span className="nav-card-title">Most expensive sessions</span>
            <span className="nav-card-sub">Ranked by estimated cost ›</span>
          </button>
          <button className={`nav-card ${route.project && !route.session ? "active" : ""}`} onClick={() => navigate({ project: sideProject })}>
            <Caption>Project</Caption>
            <span className="nav-card-title">{sidebarProject ? projectName(sidebarProject.cwd) : "…"}</span>
            <span className="nav-card-sub">Overview across all sessions ›</span>
          </button>

          <SectionRule label="Sessions" count={sessions?.length} />
          <input className="search" placeholder="Filter sessions" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ol className="session-list">
            {!sessions && sideProject && <li className="muted small">Loading sessions…</li>}
            {shown?.map((s) => (
              <li key={s.id}>
                <button
                  className="session-item"
                  data-active={route.session === s.id || undefined}
                  onClick={() => navigate({ project: sideProject, session: s.id })}
                  title={s.firstPrompt}
                >
                  <span className="index">{String(sessions!.indexOf(s) + 1).padStart(2, "0")}</span>
                  <span className="session-label">
                    <span className="session-title">{s.title ?? s.firstPrompt ?? s.id}</span>
                    <span className="session-meta">
                      {fmtDate(s.mtime)} · {fmtSize(s.size)}
                      {s.subagentCount > 0 && ` · ${s.subagentCount} agents`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <main className="main">
          {error && <div className="notice tone-risk">{error}</div>}
          {loading && <div className="loading">{loading}</div>}
          {session && route.project && (
            <SessionView session={session} project={route.project} subagents={subagents} onOpen={setDetail} selectedCall={detail?.call.id ?? null} />
          )}
          {!route.project && projects && projects.length > 0 && (
            <TopView subagents={subagents} onOpenSession={(dir, id) => navigate({ project: dir, session: id })} />
          )}
          {!route.session && project && (
            <Overview project={project} subagents={subagents} onOpenSession={(id) => navigate({ project: project.dir, session: id })} />
          )}
          {projects && !projects.length && <div className="empty">No Claude Code sessions found in ~/.claude/projects.</div>}
        </main>
      </div>

      <DetailDrawer target={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function Overview({ project, subagents, onOpenSession }: { project: ProjectInfo; subagents: boolean; onOpenSession: (id: string) => void }) {
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sinceDays, setSinceDays] = useState(0);
  const [sort, setSort] = useState<"newest" | "cost">("newest");

  useEffect(() => {
    setStats(null);
    setError(null);
    let live = true;
    api
      .projectStats(project.dir, subagents, sinceDays)
      .then((s) => live && setStats(s))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [project.dir, subagents, sinceDays]);

  const t = stats?.total;
  return (
    <article className="page">
      <header className="page-head">
        <Caption tone="before">Project</Caption>
        <h1>{projectName(project.cwd)}</h1>
        <div className="page-meta">
          <span className="mono">{project.cwd}</span>
          <span className="dot">·</span>
          {project.sessionCount} sessions
          <span className="dot">·</span>
          last active {fmtDate(project.lastActive)}
        </div>
        <div className="seg">
          {(
            [
              [0, "All time"],
              [7, "Last 7 days"],
              [30, "Last 30 days"],
            ] as const
          ).map(([d, label]) => (
            <button key={d} className={sinceDays === d ? "active" : ""} onClick={() => setSinceDays(d)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {error && <div className="notice tone-risk">{error}</div>}
      {!stats && !error && <div className="loading">Analyzing sessions. The first run parses every log; later runs use the cache.</div>}
      {t && stats && (
        <>
          <div className="summary">
            <Stats
              st={t}
              runs={t.runTotals}
              extra={{ prompts: stats.sessions.reduce((s, r) => s + r.prompts, 0), reminders: stats.sessions.reduce((s, r) => s + r.reminders, 0) }}
            />
            <div className="summary-side">
              <CostPanel st={t} />
              <Histogram histogram={t.histogram} total={t.toolTurns} />
            </div>
          </div>

          <section className="section">
            <SectionRule label="Sessions" count={stats.sessions.length}>
              <div className="seg seg-inline">
                {(
                  [
                    ["newest", "Newest"],
                    ["cost", "Most expensive"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={sort === k ? "active" : ""} onClick={() => setSort(k)}>
                    {label}
                  </button>
                ))}
              </div>
            </SectionRule>
            <table className="grid clickable">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Started</th>
                  <th className="r">Turns</th>
                  <th className="r">Calls</th>
                  <th className="r">Avg</th>
                  <th className="r">Single</th>
                  <th className="r">Runs</th>
                  <th className="r">Saved</th>
                  <th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sortRows(stats.sessions, sort).map((s) => (
                  <tr key={s.id} onClick={() => onOpenSession(s.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpenSession(s.id)}>
                    <td className="ellipsis-cell strong" title={s.firstPrompt}>
                      {s.title ?? s.firstPrompt ?? s.id}
                    </td>
                    <td className="muted nowrap">{fmtDate(s.startedAt)}</td>
                    <td className="r num">{s.stats.turns.toLocaleString()}</td>
                    <td className="r num">{s.stats.toolCalls.toLocaleString()}</td>
                    <td className="r num">{s.stats.avgBatch.toFixed(1)}</td>
                    <td className={`r num strong ${singleClass(s.stats.singleCallTurns, s.stats.toolTurns)}`}>
                      {pct(s.stats.singleCallTurns, s.stats.toolTurns)}
                    </td>
                    <td className="r num strong">
                      <span className="bad">{s.stats.runTotals.likely.runs}</span>
                      <span className="muted"> / </span>
                      <span className="warn">{s.stats.runTotals.possibly.runs}</span>
                    </td>
                    <td className="r num">{formatMs(s.stats.savedMs)}</td>
                    <td className="r num strong">{formatUsd(s.stats.cost.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="section">
            <SectionRule label="Tools" count={Object.keys(t.byTool).length} />
            <ToolsTable byTool={t.byTool} />
          </section>
        </>
      )}
    </article>
  );
}

const sortRows = <T extends SessionRow>(rows: T[], sort: "newest" | "cost") =>
  sort === "cost" ? [...rows].sort((a, b) => b.stats.cost.total - a.stats.cost.total) : rows;

const RANGES = [
  [7, "Last 7 days"],
  [30, "Last 30 days"],
  [0, "All time"],
] as const;

/** Sessions across every project, most expensive first: where to start digging. */
function TopView({ subagents, onOpenSession }: { subagents: boolean; onOpenSession: (project: string, id: string) => void }) {
  const [data, setData] = useState<TopSessions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sinceDays, setSinceDays] = useState(30);
  const [limit, setLimit] = useState(25);

  useEffect(() => {
    setData(null);
    setError(null);
    let live = true;
    api
      .top(subagents, sinceDays)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [subagents, sinceDays]);

  const t = data?.total;
  const rows = data?.sessions ?? [];
  const top5 = rows.slice(0, 5).reduce((s, r) => s + r.stats.cost.total, 0);
  const maxCost = rows[0]?.stats.cost.total ?? 0;
  return (
    <article className="page">
      <header className="page-head">
        <Caption tone="before">All projects</Caption>
        <h1>Most expensive sessions</h1>
        <div className="page-meta">Estimated at Anthropic API list prices, from the token usage recorded in each session log.</div>
        <div className="seg">
          {RANGES.map(([d, label]) => (
            <button key={d} className={sinceDays === d ? "active" : ""} onClick={() => setSinceDays(d)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {error && <div className="notice tone-risk">{error}</div>}
      {!data && !error && <div className="loading">Analyzing every session. The first run parses all logs; later runs use the cache.</div>}
      {t && data && (
        <>
          <div className="summary">
            <dl className="stats">
              <TopStat label="Sessions" value={rows.length.toLocaleString()} sub={`${t.turns.toLocaleString()} turns`} />
              <TopStat label="Total" value={formatUsd(t.cost.total)} sub={rows.length ? `${formatUsd(t.cost.total / rows.length)} per session` : undefined} />
              <TopStat label="Top 5 sessions" value={pct(top5, t.cost.total)} sub={`${formatUsd(top5)} of the total`} />
              <TopStat label="Peak context" value={formatTokens(t.peakContext)} sub="largest single turn" />
              <TopStat
                label="Batching could save"
                value={`~${formatUsd(t.savedCost)}`}
                sub={`${pct(t.savedCost, t.cost.total)} · ${t.savedTurns.toLocaleString()} round-trips`}
              />
            </dl>
            <CostPanel st={t} />
          </div>

          <section className="section">
            <SectionRule label="Sessions by cost" count={rows.length} />
            <table className="grid clickable fit">
              <thead>
                <tr>
                  <th className="r">#</th>
                  <th>Session</th>
                  <th>Project</th>
                  <th>Last active</th>
                  <th className="r">Turns</th>
                  <th className="r" title="Largest context any single turn read">
                    Peak ctx
                  </th>
                  <th className="r">Per turn</th>
                  <th className="r" title="Share of the cost spent re-reading cached context">
                    Cache read
                  </th>
                  <th className="r" title="Context re-reads that batchable runs would have avoided">
                    Batching
                  </th>
                  <th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((s, i) => (
                  <tr
                    key={`${s.projectDir}/${s.id}`}
                    onClick={() => onOpenSession(s.projectDir, s.id)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && onOpenSession(s.projectDir, s.id)}
                  >
                    <td className="r num muted">{String(i + 1).padStart(2, "0")}</td>
                    <td className="ellipsis-cell strong" title={s.firstPrompt}>
                      {s.title ?? s.firstPrompt ?? s.id}
                    </td>
                    <td className="muted nowrap clip" title={s.project}>
                      {projectName(s.project)}
                    </td>
                    <td className="muted nowrap">{fmtDate(s.endedAt)}</td>
                    <td className="r num">{s.stats.turns.toLocaleString()}</td>
                    <td className="r num">{formatTokens(s.stats.peakContext)}</td>
                    <td className="r num">{s.stats.turns ? formatUsd(s.stats.cost.total / s.stats.turns) : "–"}</td>
                    <td className="r num">{pct(s.stats.cost.cacheRead, s.stats.cost.total)}</td>
                    <td className="r num">{s.stats.savedCost ? formatUsd(s.stats.savedCost) : <span className="muted">–</span>}</td>
                    <td className="r num strong nowrap">
                      {formatUsd(s.stats.cost.total)}
                      <span className="share-track" aria-hidden>
                        <span className="share-bar" style={{ width: `${maxCost ? (s.stats.cost.total / maxCost) * 100 : 0}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > limit && (
              <button className="link show-more" onClick={() => setLimit(limit + 50)}>
                Show more ({rows.length - limit} left)
              </button>
            )}
            {!rows.length && <div className="empty">No sessions in this range.</div>}
          </section>
        </>
      )}
    </article>
  );
}

function TopStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <dt>
        <Caption>{label}</Caption>
      </dt>
      <dd className="stat-value">{value}</dd>
      {sub && <dd className="stat-sub">{sub}</dd>}
    </div>
  );
}
