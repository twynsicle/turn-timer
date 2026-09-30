import { useMemo, useState } from "react";
import { type DailyCost, type ToolStat, addDaily } from "../../src/core/metrics.js";
import type { ReportIndex, SessionRow } from "../../src/core/report-data.js";
import { DailyCostChart } from "./DailyCost.js";
import { ToolTable } from "./ToolTable.js";
import { Caption, ModelBar, ModelLegend, SectionRule, Seg, Stat, Tabs, fmtDate, fmtRange, formatMs, formatUsd, pct, plural, projectName } from "./ui.js";

type Sort = "cost" | "time" | "turns" | "misses" | "recent";
type ListTab = "list" | "slow" | "tools";

const SORTS: [Sort, string][] = [
  ["cost", "Cost"],
  ["time", "Time"],
  ["turns", "Turns"],
  ["misses", "Cache misses"],
  ["recent", "Recent"],
];

function readPref<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // preferences are best-effort
  }
}

/** Sort order shared by both lists, remembered across visits. */
function useSort(): [Sort, (s: Sort) => void] {
  const [sort, setSort] = useState<Sort>(() => readPref("csv.sort", SORTS.map(([k]) => k), "cost"));
  return [
    sort,
    (s) => {
      setSort(s);
      writePref("csv.sort", s);
    },
  ];
}

type Totals = ReturnType<typeof totals>;

export function totals(rows: SessionRow[]) {
  const t = {
    sessions: rows.length,
    cost: 0,
    byModel: {} as Record<string, number>,
    byDay: {} as DailyCost,
    activeMs: 0,
    prompts: 0,
    turns: 0,
    toolCalls: 0,
    misses: 0,
    missCost: 0,
    expiries: 0,
    expiryCost: 0,
    firstAt: Infinity,
    lastAt: 0,
    byTool: {} as Record<string, ToolStat>,
  };
  for (const r of rows) {
    t.cost += r.cost.total;
    for (const [m, c] of Object.entries(r.costByModel)) t.byModel[m] = (t.byModel[m] ?? 0) + c;
    addDaily(t.byDay, r.costByDay);
    t.activeMs += r.activeMs;
    t.prompts += r.prompts;
    t.turns += r.turns;
    t.toolCalls += r.toolCalls;
    t.misses += r.misses;
    t.missCost += r.missCost;
    t.expiries += r.expiries;
    t.expiryCost += r.expiryCost;
    t.firstAt = Math.min(t.firstAt, r.startedAt);
    t.lastAt = Math.max(t.lastAt, r.endedAt);
    for (const [name, s] of Object.entries(r.byTool)) {
      const acc = (t.byTool[name] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0 });
      acc.calls += s.calls;
      acc.errors += s.errors;
      acc.totalMs += s.totalMs;
      acc.maxMs = Math.max(acc.maxMs, s.maxMs);
    }
  }
  return t;
}

const sortValue: Record<Sort, (t: Totals) => number> = {
  cost: (t) => t.cost,
  time: (t) => t.activeMs,
  turns: (t) => t.turns,
  misses: (t) => t.missCost,
  recent: (t) => t.lastAt,
};

const rowSortValue: Record<Sort, (r: SessionRow) => number> = {
  cost: (r) => r.cost.total,
  time: (r) => r.activeMs,
  turns: (r) => r.turns,
  misses: (r) => r.missCost,
  recent: (r) => r.endedAt,
};

function Summary({ t }: { t: Totals }) {
  return (
    <section className="summary">
      <div className="cost-panel">
        <Caption>Estimated cost</Caption>
        <div className="cost-total">{formatUsd(t.cost)}</div>
        <div className="stat-sub">at API list prices · {t.sessions ? `${formatUsd(t.cost / t.sessions)} per session` : "no sessions"}</div>
        <ModelBar byModel={t.byModel} height={12} />
        <ModelLegend byModel={t.byModel} />
      </div>
      <dl className="stats">
        <Stat label="Sessions" value={t.sessions.toLocaleString()} sub={plural(t.prompts, "prompt")} />
        <Stat label="Time working" value={formatMs(t.activeMs)} sub={t.prompts ? `${formatMs(t.activeMs / t.prompts)} per prompt` : undefined} />
        <Stat label="Turns" value={t.turns.toLocaleString()} sub={plural(t.toolCalls, "tool call")} />
        <Stat
          label="Cache misses"
          value={t.misses.toLocaleString()}
          sub={
            t.misses ? (
              <>
                {formatUsd(t.missCost)} extra · {pct(t.missCost, t.cost)} of cost
                <br />
                {plural(t.expiries, "expiry", "expiries")} · {formatUsd(t.expiryCost)}
              </>
            ) : (
              "no context rebuilt"
            )
          }
        />
      </dl>
      <DailyCostChart byDay={t.byDay} />
    </section>
  );
}

const MissCell = ({ n, cost }: { n: number; cost: number }) =>
  n ? (
    <>
      {n.toLocaleString()} <span className="muted">· {formatUsd(cost)}</span>
    </>
  ) : (
    <span className="muted">–</span>
  );

function CostCell({ byModel, total, scale }: { byModel: Record<string, number>; total: number; scale: number }) {
  return (
    <span className="cost-cell">
      <ModelBar byModel={byModel} scale={scale} />
      <span className="num strong">{formatUsd(total)}</span>
    </span>
  );
}

function ListHead({ name }: { name: string }) {
  return (
    <thead>
      <tr>
        <th className="r">#</th>
        <th>{name}</th>
        <th className="r" title="Time Claude spent working: each prompt to its last activity. Idle time between prompts is left out.">
          Time
        </th>
        <th className="r">Turns</th>
        <th className="r" title="Turns that rebuilt context the previous turn had cached, and what that cost over reading it">
          Cache misses
        </th>
        <th className="cost-col">Cost</th>
      </tr>
    </thead>
  );
}

const rowProps = (go: () => void) => ({ onClick: go, tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && go() });

function Failed({ failed }: { failed: ReportIndex["failed"] }) {
  if (!failed.length) return null;
  return (
    <section className="section">
      <SectionRule label="Couldn't read" count={failed.length} />
      <ul className="small muted">
        {failed.map((f) => (
          <li key={f.path}>
            <span className="mono">{f.path}</span>: {f.error}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProjectsPage({ index, onProject, onSession }: { index: ReportIndex; onProject: (cwd: string) => void; onSession: (key: string, call?: string) => void }) {
  const [sort, setSort] = useSort();
  const [tab, setTab] = useState<ListTab>("list");

  const projects = useMemo(() => {
    // By working directory, not log folder: a worktree's sessions log under their own folder.
    const m = new Map<string, SessionRow[]>();
    for (const r of index.sessions) {
      const rows = m.get(r.project);
      if (rows) rows.push(r);
      else m.set(r.project, [r]);
    }
    return [...m].map(([cwd, rows]) => ({ cwd, t: totals(rows) }));
  }, [index]);
  const sorted = useMemo(() => [...projects].sort((a, b) => sortValue[sort](b.t) - sortValue[sort](a.t)), [projects, sort]);
  const t = useMemo(() => totals(index.sessions), [index]);
  const maxCost = Math.max(0, ...projects.map((p) => p.t.cost));

  return (
    <article className="page">
      <header className="page-head">
        <h1>Projects</h1>
        <div className="page-meta">{t.sessions ? `Sessions from ${fmtRange(t.firstAt, t.lastAt)}` : "No sessions"}</div>
      </header>
      <Summary t={t} />
      <Tabs<ListTab>
        tabs={[
          ["list", "Projects", projects.length],
          ["slow", "Slowest tool calls"],
          ["tools", "Tools", Object.keys(t.byTool).length],
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === "list" && <Seg label="Sort by" options={SORTS} value={sort} onChange={setSort} />}
      </Tabs>
      {tab === "list" && (
        <table className="grid clickable list">
          <ListHead name="Project" />
          <tbody>
            {sorted.map((p, i) => (
              <tr key={p.cwd} {...rowProps(() => onProject(p.cwd))}>
                <td className="r index">{String(i + 1).padStart(2, "0")}</td>
                <td className="name-cell">
                  <span className="name" title={p.cwd}>
                    {projectName(p.cwd)}
                  </span>
                  <span className="name-meta">
                    {plural(p.t.sessions, "session")} · {fmtRange(p.t.firstAt, p.t.lastAt)}
                  </span>
                </td>
                <td className="r num">{formatMs(p.t.activeMs)}</td>
                <td className="r num">{p.t.turns.toLocaleString()}</td>
                <td className="r num">
                  <MissCell n={p.t.misses} cost={p.t.missCost} />
                </td>
                <td className="cost-col">
                  <CostCell byModel={p.t.byModel} total={p.t.cost} scale={maxCost} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === "slow" && <SlowCalls rows={index.sessions} onOpen={onSession} showProject />}
      {tab === "tools" && <ToolTable byTool={t.byTool} />}
      <Failed failed={index.failed} />
    </article>
  );
}

export function SessionsPage({ index, cwd, onBack, onSession }: { index: ReportIndex; cwd: string; onBack: () => void; onSession: (key: string, call?: string) => void }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useSort();
  const [tab, setTab] = useState<ListTab>("list");
  const [limit, setLimit] = useState(50);

  const all = useMemo(() => index.sessions.filter((r) => r.project === cwd), [index, cwd]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all
      .filter((r) => !needle || `${r.title ?? ""} ${r.firstPrompt ?? ""} ${r.id}`.toLowerCase().includes(needle))
      .sort((a, b) => rowSortValue[sort](b) - rowSortValue[sort](a));
  }, [all, search, sort]);
  const t = useMemo(() => totals(rows), [rows]);
  const maxCost = Math.max(0, ...rows.map((r) => r.cost.total));

  return (
    <article className="page">
      <header className="page-head">
        <button className="link back" onClick={onBack}>
          ← All projects
        </button>
        <h1 title={cwd}>{projectName(cwd)}</h1>
        <div className="page-meta">
          <span className="mono">{cwd}</span>
          {all.length > 0 && (
            <>
              <span className="dot">·</span>
              {fmtRange(Math.min(...all.map((r) => r.startedAt)), Math.max(...all.map((r) => r.endedAt)))}
            </>
          )}
        </div>
        <div className="filters">
          <input className="search" type="search" placeholder="Search titles and prompts" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </header>
      <Summary t={t} />
      <Tabs<ListTab>
        tabs={[
          ["list", "Sessions", rows.length],
          ["slow", "Slowest tool calls"],
          ["tools", "Tools", Object.keys(t.byTool).length],
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === "list" && <Seg label="Sort by" options={SORTS} value={sort} onChange={setSort} />}
      </Tabs>
      {tab === "list" && (
        <>
          <table className="grid clickable list">
            <ListHead name="Session" />
            <tbody>
              {rows.slice(0, limit).map((r, i) => (
                <tr key={r.key} {...rowProps(() => onSession(r.key))}>
                  <td className="r index">{String(i + 1).padStart(2, "0")}</td>
                  <td className="name-cell">
                    <span className="name" title={r.firstPrompt}>
                      {r.title ?? r.firstPrompt ?? r.id}
                    </span>
                    <span className="name-meta">
                      {fmtDate(r.endedAt)} · {plural(r.prompts, "prompt")}
                    </span>
                  </td>
                  <td className="r num">{formatMs(r.activeMs)}</td>
                  <td className="r num">{r.turns.toLocaleString()}</td>
                  <td className="r num">
                    <MissCell n={r.misses} cost={r.missCost} />
                  </td>
                  <td className="cost-col">
                    <CostCell byModel={r.costByModel} total={r.cost.total} scale={maxCost} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <button className="link show-more" onClick={() => setLimit(limit + 100)}>
              Show more ({rows.length - limit} left)
            </button>
          )}
          {!rows.length && <div className="empty">No sessions match.</div>}
        </>
      )}
      {tab === "slow" && <SlowCalls rows={rows} onOpen={onSession} showProject={false} />}
      {tab === "tools" && <ToolTable byTool={t.byTool} />}
    </article>
  );
}

function SlowCalls({ rows, onOpen, showProject }: { rows: SessionRow[]; onOpen: (key: string, call?: string) => void; showProject: boolean }) {
  const calls = useMemo(
    () =>
      rows
        .flatMap((r) => r.slowest.map((c) => ({ ...c, row: r })))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 100),
    [rows],
  );
  if (!calls.length) return <div className="empty">No tool calls.</div>;
  return (
    <>
      <p className="prose muted">The longest-running tool calls across these sessions: the five slowest from each session. Click one to see it in its session.</p>
      <table className="grid clickable fit">
        <thead>
          <tr>
            <th className="r">Time</th>
            <th>Tool</th>
            <th>Input</th>
            <th>Session</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={`${c.row.key}/${c.id}`} {...rowProps(() => onOpen(c.row.key, c.id))}>
              <td className="r num strong nowrap">{formatMs(c.ms)}</td>
              <td className="nowrap">
                <span className="strong">{c.name}</span>
                {c.agentType && <span className="tag tone-before">{c.agentType}</span>}
                {c.isError && <span className="tag tone-risk">error</span>}
              </td>
              <td className="ellipsis-cell mono" title={c.summary}>
                {c.summary}
              </td>
              <td className="clip muted" title={c.row.title ?? c.row.firstPrompt}>
                {showProject && `${projectName(c.row.project)} · `}
                {c.row.title ?? c.row.firstPrompt ?? c.row.id}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
