import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReportIndex } from "../../src/core/report-data.js";
import { ProjectsPage, SessionsPage } from "./ListPages.js";
import { SessionPage } from "./SessionPage.js";
import { fmtDate, fmtRange } from "./ui.js";

/** `#/` projects · `#/p/<project cwd>` a project's sessions · `#/s/<key>[/<callId>]` one session. */
interface Route {
  project?: string;
  session?: string;
  call?: string;
}

const readRoute = (): Route => {
  let parts: string[];
  try {
    parts = location.hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  } catch {
    return {}; // a malformed link: start at the projects list
  }
  const [, kind, id, call] = parts;
  if (kind === "s" && id) return { session: id, call: call || undefined };
  if (kind === "p" && id) return { project: id };
  return {};
};

const toHash = (r: Route) =>
  r.session
    ? `#/s/${encodeURIComponent(r.session)}${r.call ? `/${encodeURIComponent(r.call)}` : ""}`
    : r.project
      ? `#/p/${encodeURIComponent(r.project)}`
      : "#/";

export function App({ index }: { index: ReportIndex }) {
  const [route, setRoute] = useState<Route>(readRoute);
  // The list pages stay mounted (hidden) under a session so their search and tabs survive.
  const lastList = useRef(route.project);
  if (!route.session) lastList.current = route.project;
  const listProject = lastList.current;
  const scrolls = useRef(new Map<string, number>());
  const prev = useRef<Route | null>(null);

  useEffect(() => {
    const onPop = () => {
      scrolls.current.set(toHash(route), window.scrollY);
      prev.current = null;
      setRoute(readRoute());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [route]);

  const navigate = useCallback(
    (r: Route) => {
      scrolls.current.set(toHash(route), window.scrollY);
      prev.current = route;
      history.pushState(null, "", toHash(r));
      setRoute(r);
    },
    [route],
  );

  useLayoutEffect(() => {
    window.scrollTo(0, route.session ? 0 : (scrolls.current.get(toHash(route)) ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.session, route.project]);

  const row = route.session ? index.sessions.find((s) => s.key === route.session) : undefined;
  const openSession = (session: string, call?: string) => navigate({ session, call });
  // Back to where we came from when that was the list above; otherwise to the list itself.
  const up = (target: Route) => () => {
    const p = prev.current;
    if (p && !p.session && p.project === target.project) history.back();
    else navigate(target);
  };
  const listing = !route.session;
  const first = Math.min(...index.sessions.map((s) => s.startedAt));
  const last = Math.max(...index.sessions.map((s) => s.endedAt));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand" onClick={() => navigate({})}>
            <span className="brand-mark" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            Claude Session Viewer
          </button>
          <span className="topbar-meta">
            {index.sessions.length > 0 && <>{fmtRange(first, last)} · </>}
            {index.sinceDays ? `last ${index.sinceDays} days` : "everything on disk"}
            {index.projectFilter ? ` · projects matching “${index.projectFilter}”` : ""} · generated {fmtDate(index.generatedAt)}
          </span>
        </div>
      </header>
      <main className="main">
        <div hidden={!listing || !!route.project}>
          <ProjectsPage index={index} onProject={(project) => navigate({ project })} onSession={openSession} />
        </div>
        {listProject && (
          <div hidden={!listing || route.project !== listProject}>
            <SessionsPage key={listProject} index={index} cwd={listProject} onBack={up({})} onSession={openSession} />
          </div>
        )}
        {route.session &&
          (row ? (
            <SessionPage key={row.key} row={row} focusCall={route.call} onBack={up({ project: row.project })} />
          ) : (
            <div className="empty">This report has no session {route.session}.</div>
          ))}
      </main>
    </div>
  );
}
