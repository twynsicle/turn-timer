import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo, Session, SessionInfo } from "../../src/core/types.js";
import { api, type ProjectStats } from "./api.js";
import { type DetailTarget, DetailDrawer, Histogram, Tiles, ToolsTable, fmtDate, fmtSize, formatMs, pct, singleClass } from "./common.js";
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

  // Default to the most recently active project.
  useEffect(() => {
    if (!route.project && projects?.length) navigate({ project: projects[0]!.dir });
  }, [projects, route.project, navigate]);

  useEffect(() => {
    setSessions(null);
    setFilter("");
    if (!route.project) return;
    api.sessions(route.project).then(setSessions, (e: Error) => setError(e.message));
  }, [route.project]);

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
  const shown = sessions?.filter((s) => {
    if (!filter) return true;
    const hay = `${s.id} ${s.title ?? ""} ${s.firstPrompt ?? ""}`.toLowerCase();
    return hay.includes(filter.toLowerCase());
  });

  return (
    <div className={`app ${detail ? "with-drawer" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          turn-timer
        </div>
        <label className="field">
          <span className="field-label">Project</span>
          <select value={route.project ?? ""} onChange={(e) => navigate({ project: e.target.value })}>
            {!projects && <option>Loading…</option>}
            {projects?.map((p) => (
              <option key={p.dir} value={p.dir}>
                {p.cwd.split(/[\\/]/).slice(-2).join("/")} ({p.sessionCount})
              </option>
            ))}
          </select>
        </label>
        <button className={`nav-item ${route.project && !route.session ? "active" : ""}`} onClick={() => navigate({ project: route.project })}>
          Project overview
        </button>
        <input className="search" placeholder="Filter sessions" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="session-list">
          {!sessions && route.project && <div className="muted small pad">Loading sessions…</div>}
          {shown?.map((s) => (
            <button
              key={s.id}
              className={`session-item ${route.session === s.id ? "active" : ""}`}
              onClick={() => navigate({ project: route.project, session: s.id })}
              title={s.firstPrompt}
            >
              <span className="session-title">{s.title ?? s.firstPrompt ?? s.id}</span>
              <span className="session-meta">
                {fmtDate(s.mtime)} · {fmtSize(s.size)}
                {s.subagentCount > 0 && ` · ${s.subagentCount} agents`}
              </span>
            </button>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={subagents} onChange={(e) => setSubagents(e.target.checked)} />
          Include subagents
        </label>
      </aside>

      <main className="main">
        {error && <div className="error banner">{error}</div>}
        {loading && <div className="loading">{loading}</div>}
        {session && route.project && (
          <SessionView
            session={session}
            project={route.project}
            subagents={subagents}
            onOpen={setDetail}
            selectedCall={detail?.call.id ?? null}
          />
        )}
        {!route.session && project && (
          <Overview project={project} subagents={subagents} onOpenSession={(id) => navigate({ project: project.dir, session: id })} />
        )}
        {projects && !projects.length && <div className="empty">No Claude Code sessions found in ~/.claude/projects.</div>}
      </main>

      <DetailDrawer target={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function Overview({ project, subagents, onOpenSession }: { project: ProjectInfo; subagents: boolean; onOpenSession: (id: string) => void }) {
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sinceDays, setSinceDays] = useState(0);

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
    <div className="overview">
      <header className="page-head">
        <h1>{project.cwd}</h1>
        <div className="muted small">
          {project.sessionCount} sessions · last active {fmtDate(project.lastActive)}
          <span className="seg inline">
            {[
              [0, "All time"],
              [7, "7 days"],
              [30, "30 days"],
            ].map(([d, label]) => (
              <button key={d} className={sinceDays === d ? "active" : ""} onClick={() => setSinceDays(d as number)}>
                {label}
              </button>
            ))}
          </span>
        </div>
      </header>
      {error && <div className="error banner">{error}</div>}
      {!stats && !error && <div className="loading">Analyzing sessions… the first run parses every log, later runs use the cache.</div>}
      {t && stats && (
        <>
          <div className="summary-row">
            <Tiles
              st={t}
              extra={{ prompts: stats.sessions.reduce((s, r) => s + r.prompts, 0), reminders: stats.sessions.reduce((s, r) => s + r.reminders, 0) }}
              runs={t.runTotals}
            />
            <Histogram histogram={t.histogram} total={t.toolTurns} />
          </div>
          <p className="muted small">
            Batching would have saved about <b>{t.savedTurns.toLocaleString()}</b> round-trips and <b>{formatMs(t.savedMs)}</b> of model time.
          </p>
          <h3>Sessions</h3>
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
                <th className="r">Saveable</th>
              </tr>
            </thead>
            <tbody>
              {stats.sessions.map((s) => (
                <tr key={s.id} onClick={() => onOpenSession(s.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpenSession(s.id)}>
                  <td className="ellipsis-cell" title={s.firstPrompt}>
                    {s.title ?? s.firstPrompt ?? s.id}
                  </td>
                  <td className="muted small nowrap">{fmtDate(s.startedAt)}</td>
                  <td className="r num">{s.stats.turns.toLocaleString()}</td>
                  <td className="r num">{s.stats.toolCalls.toLocaleString()}</td>
                  <td className="r num">{s.stats.avgBatch.toFixed(1)}</td>
                  <td className={`r num ${singleClass(s.stats.singleCallTurns, s.stats.toolTurns)}`}>{pct(s.stats.singleCallTurns, s.stats.toolTurns)}</td>
                  <td className="r num">
                    <span className="bad">{s.stats.runTotals.likely.runs}</span>
                    <span className="muted">/</span>
                    <span className="warn">{s.stats.runTotals.possibly.runs}</span>
                  </td>
                  <td className="r num">{formatMs(s.stats.savedMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Tools</h3>
          <ToolsTable byTool={t.byTool} />
        </>
      )}
    </div>
  );
}
