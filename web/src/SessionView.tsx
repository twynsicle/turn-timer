import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  type BatchableRun,
  type Stats,
  promptStats,
  runTotals,
  sessionStats,
  turnModelMs,
  turnToolMs,
} from "../../src/core/metrics.js";
import type { Prompt, Session, ToolCall, Turn } from "../../src/core/types.js";
import { type DetailTarget, Histogram, Tiles, ToolsTable, fmtDate, formatMs, pct, singleClass } from "./common.js";

type Tab = "prompts" | "runs" | "tools";

interface Ctx {
  project: string;
  sessionId: string;
  subagents: boolean;
  runOf: Map<string, BatchableRun>;
  focusTurn: string | null;
  onOpen: (t: DetailTarget) => void;
  selectedCall: string | null;
}

export function SessionView({
  session,
  project,
  subagents,
  onOpen,
  selectedCall,
}: {
  session: Session;
  project: string;
  subagents: boolean;
  onOpen: (t: DetailTarget) => void;
  selectedCall: string | null;
}) {
  const opts = { subagents };
  const st = useMemo(() => sessionStats(session, opts), [session, subagents]);
  const perPrompt = useMemo(() => new Map(session.prompts.map((p) => [p.index, promptStats(p, opts)])), [session, subagents]);
  const runOf = useMemo(() => {
    const m = new Map<string, BatchableRun>();
    for (const r of st.runs) for (const id of r.turnIds) m.set(id, r);
    return m;
  }, [st]);

  const [tab, setTab] = useState<Tab>("prompts");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [focusTurn, setFocusTurn] = useState<string | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  useEffect(() => {
    setExpanded(new Set());
    setFocusTurn(null);
    setTab("prompts");
  }, [session.id]);

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const jumpToRun = (r: BatchableRun) => {
    setTab("prompts");
    setOnlyFlagged(false);
    setExpanded((prev) => new Set(prev).add(r.promptIndex));
    setFocusTurn(r.turnIds[0]!);
  };

  const ctx: Ctx = { project, sessionId: session.id, subagents, runOf, focusTurn, onOpen, selectedCall };
  const prompts = session.prompts.filter((p) => {
    const ps = perPrompt.get(p.index)!;
    if (hideEmpty && ps.toolCalls === 0) return false;
    if (onlyFlagged && ps.runs.length === 0) return false;
    return true;
  });
  const title = session.title ?? session.prompts.find((p) => p.kind === "user")?.text ?? session.id;

  return (
    <div className="session">
      <header className="page-head">
        <h1 title={title}>{title}</h1>
        <div className="muted small">
          <span className="mono">{session.cwd}</span> · {fmtDate(session.startedAt)} → {fmtDate(session.endedAt)} ·{" "}
          <span className="mono">{session.id.slice(0, 8)}</span>
          {session.files.length > 1 && <> · {session.files.length - 1} subagent logs</>}
        </div>
      </header>

      <div className="summary-row">
        <Tiles st={st} runs={runTotals(st.runs)} extra={{ prompts: session.prompts.length, reminders: session.batchingReminders }} />
        <Histogram histogram={st.histogram} total={st.toolTurns} />
      </div>

      <nav className="tabs" role="tablist">
        {(
          [
            ["prompts", `Prompts (${session.prompts.length})`],
            ["runs", `Batchable runs (${st.runs.length})`],
            ["tools", `Tools (${Object.keys(st.byTool).length})`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
        {tab === "prompts" && (
          <div className="tab-tools">
            <label>
              <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide prompts without tools
            </label>
            <label>
              <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Only with runs
            </label>
            <button className="link" onClick={() => setExpanded(new Set(prompts.map((p) => p.index)))}>
              Expand all
            </button>
            <button className="link" onClick={() => setExpanded(new Set())}>
              Collapse all
            </button>
          </div>
        )}
      </nav>

      {tab === "prompts" && (
        <div className="prompts">
          <div className="prompt-row header">
            <span className="r">#</span>
            <span>Prompt</span>
            <span className="r">Turns</span>
            <span className="r">Calls</span>
            <span className="r">Avg</span>
            <span className="r">Single</span>
            <span className="r">Runs</span>
            <span className="r">Saveable</span>
            <span className="r">Model</span>
          </div>
          {prompts.map((p) => (
            <PromptBlock key={p.index} p={p} st={perPrompt.get(p.index)!} open={expanded.has(p.index)} onToggle={() => toggle(p.index)} ctx={ctx} />
          ))}
          {!prompts.length && <div className="empty">No prompts match the filters.</div>}
        </div>
      )}
      {tab === "runs" && <RunsList runs={st.runs} session={session} onJump={jumpToRun} />}
      {tab === "tools" && <ToolsTable byTool={st.byTool} />}
    </div>
  );
}

const PromptBlock = memo(function PromptBlock({
  p,
  st,
  open,
  onToggle,
  ctx,
}: {
  p: Prompt;
  st: Stats;
  open: boolean;
  onToggle: () => void;
  ctx: Ctx;
}) {
  const likely = st.runs.filter((r) => r.kind === "likely").length;
  const possibly = st.runs.length - likely;
  return (
    <div className={`prompt ${open ? "open" : ""}`}>
      <button className="prompt-row" onClick={onToggle} aria-expanded={open}>
        <span className="r muted num">{p.index + 1}</span>
        <span className="prompt-text">
          <span className="caret">{open ? "▾" : "▸"}</span>
          {p.kind === "notification" && <span className="pill">notification</span>}
          {p.kind === "command" && <span className="pill">command</span>}
          {p.interrupted && <span className="pill warn">interrupted</span>}
          {p.compacted && <span className="pill">compacted</span>}
          <span className="ellipsis">{p.text || "(empty)"}</span>
        </span>
        <span className="r num">{st.turns}</span>
        <span className="r num">{st.toolCalls}</span>
        <span className="r num">{st.avgBatch.toFixed(1)}</span>
        <span className={`r num ${singleClass(st.singleCallTurns, st.toolTurns)}`}>{pct(st.singleCallTurns, st.toolTurns)}</span>
        <span className="r num">
          {st.runs.length ? (
            <>
              <span className="bad">{likely}</span>
              <span className="muted">/</span>
              <span className="warn">{possibly}</span>
            </>
          ) : (
            <span className="muted">–</span>
          )}
        </span>
        <span className="r num">{st.savedMs ? formatMs(st.savedMs) : ""}</span>
        <span className="r num muted">{formatMs(st.modelMs)}</span>
      </button>
      {open && (
        <div className="turns">
          <TurnList turns={p.turns} ctx={ctx} maxMs={maxTurnMs(p.turns)} />
        </div>
      )}
    </div>
  );
});

function maxTurnMs(turns: Turn[]): number {
  return Math.max(1, ...turns.map((t) => turnModelMs(t) + turnToolMs(t)));
}

function TurnList({ turns, ctx, maxMs }: { turns: Turn[]; ctx: Ctx; maxMs: number }) {
  return (
    <ol className="turn-list">
      {turns.map((t, i) => {
        const run = ctx.runOf.get(t.messageId);
        const runStart = run && run.turnIds[0] === t.messageId;
        const runEnd = run && run.turnIds.at(-1) === t.messageId;
        return (
          <li key={t.messageId} className={`turn-item ${run ? `in-run run-${run.kind}` : ""} ${runStart ? "run-start" : ""} ${runEnd ? "run-end" : ""}`}>
            {runStart && (
              <div className={`run-label ${run.kind}`}>
                {run.kind === "likely" ? "Likely batchable" : "Possibly batchable"}: {run.turnIds.length} turns could be 1
                <span className="muted"> · saves {run.savedTurns} round-trip{run.savedTurns === 1 ? "" : "s"}, ~{formatMs(run.savedMs)}</span>
              </div>
            )}
            <TurnRow t={t} index={i + 1} ctx={ctx} maxMs={maxMs} />
            {ctx.subagents &&
              t.toolCalls
                .filter((c) => c.subagent)
                .map((c) => <SubagentBlock key={c.id} call={c} ctx={ctx} />)}
          </li>
        );
      })}
    </ol>
  );
}

function TurnRow({ t, index, ctx, maxMs }: { t: Turn; index: number; ctx: Ctx; maxMs: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = ctx.focusTurn === t.messageId;
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  const n = t.toolCalls.length;
  const model = turnModelMs(t);
  const tools = turnToolMs(t);
  return (
    <div ref={ref} className={`turn ${focused ? "focused" : ""}`}>
      <span className="turn-idx num muted">{index}</span>
      <span className={`badge ${n === 0 ? "zero" : n === 1 ? "one" : n <= 3 ? "few" : "many"}`} title={`${n} tool call${n === 1 ? "" : "s"} in this turn`}>
        {n || "·"}
      </span>
      <div className="chips">
        {n === 0 && <span className="muted small">{t.hasText ? "text response" : "thinking only"}</span>}
        {t.toolCalls.map((c) => (
          <button
            key={c.id}
            className={`chip cat-${c.category} ${c.isError ? "err" : ""} ${c.denied ? "denied" : ""} ${ctx.selectedCall === c.id ? "selected" : ""}`}
            title={`${c.name}: ${c.summary}`}
            onClick={() => ctx.onOpen({ call: c, turn: t, project: ctx.project, session: ctx.sessionId })}
          >
            <span className="chip-name">{shortName(c.name)}</span>
            {c.summary && <span className="chip-sum">{shortSummary(c)}</span>}
          </button>
        ))}
      </div>
      <div className="timing" title={`model ${formatMs(model)} · tools ${formatMs(tools)}`}>
        <span className="time-track">
          <span className="time-model" style={{ width: `${(model / maxMs) * 100}%` }} />
          <span className="time-tool" style={{ width: `${(tools / maxMs) * 100}%` }} />
        </span>
        <span className="num small muted">{formatMs(model + tools)}</span>
      </div>
    </div>
  );
}

function SubagentBlock({ call, ctx }: { call: ToolCall; ctx: Ctx }) {
  const run = call.subagent!;
  const [open, setOpen] = useState(false);
  const st = useMemo(
    () => promptStats({ id: "", index: -1, kind: "user", text: "", startedAt: 0, interrupted: false, compacted: false, turns: run.turns }, { subagents: ctx.subagents }),
    [run, ctx.subagents],
  );
  // Auto-open when a focused turn lives inside this subagent.
  useEffect(() => {
    if (ctx.focusTurn && containsTurn(run.turns, ctx.focusTurn)) setOpen(true);
  }, [ctx.focusTurn, run]);
  return (
    <div className="subagent">
      <button className="subagent-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="pill agent">subagent · {run.agentType}</span>
        <span className="ellipsis">{run.description}</span>
        <span className="muted small num">
          {st.turns} turns · {st.toolCalls} calls · avg {st.avgBatch.toFixed(1)} ·{" "}
          <span className={singleClass(st.singleCallTurns, st.toolTurns)}>{pct(st.singleCallTurns, st.toolTurns)} single</span>
          {st.runs.length > 0 && <> · <span className="bad">{st.runs.length} runs</span></>}
        </span>
      </button>
      {open && <TurnList turns={run.turns} ctx={ctx} maxMs={maxTurnMs(run.turns)} />}
    </div>
  );
}

function containsTurn(turns: Turn[], id: string): boolean {
  return turns.some((t) => t.messageId === id || t.toolCalls.some((c) => c.subagent && containsTurn(c.subagent.turns, id)));
}

function RunsList({ runs, session, onJump }: { runs: BatchableRun[]; session: Session; onJump: (r: BatchableRun) => void }) {
  const [kind, setKind] = useState<"all" | "likely" | "possibly">("all");
  const sorted = runs.filter((r) => kind === "all" || r.kind === kind).sort((a, b) => b.savedTurns - a.savedTurns || b.savedMs - a.savedMs);
  if (!runs.length) return <div className="empty">No batchable runs found. Nice.</div>;
  return (
    <div>
      <p className="muted small explain">
        A run is a streak of turns that each made a single tool call where the calls didn't depend on each other's output.{" "}
        <b className="bad">Likely</b> runs are all read-only (Read, Grep, Glob, read-only shell). <b className="warn">Possibly</b> runs include
        edits to different files. Sorted by round-trips saved. Time saved is each extra turn's overhead: its latency minus the time spent generating output, which a batched turn would still need.
      </p>
      <div className="seg">
        {(["all", "likely", "possibly"] as const).map((k) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      <table className="grid clickable">
        <thead>
          <tr>
            <th>Kind</th>
            <th className="r">Prompt</th>
            <th>Agent</th>
            <th>Tools</th>
            <th className="r">Turns</th>
            <th className="r">Time saved</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} onClick={() => onJump(r)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onJump(r)}>
              <td>
                <span className={`pill ${r.kind === "likely" ? "bad" : "warn"}`}>{r.kind}</span>
              </td>
              <td className="r num" title={session.prompts[r.promptIndex]?.text}>
                #{r.promptIndex + 1}
              </td>
              <td>{r.agent.kind === "main" ? <span className="muted">main</span> : <span className="pill agent">{r.agent.agentType}</span>}</td>
              <td className="mono small">{compress(r.tools)}</td>
              <td className="r num">{r.turnIds.length}</td>
              <td className="r num">{formatMs(r.savedMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function compress(names: string[]): string {
  const out: [string, number][] = [];
  for (const n of names) {
    const last = out.at(-1);
    if (last && last[0] === n) last[1]++;
    else out.push([shortName(n), 1]);
  }
  return out.map(([n, k]) => (k > 1 ? `${n}×${k}` : n)).join(" → ");
}

function shortName(name: string): string {
  // mcp__server__tool → server·tool
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]!.replace(/^plugin_[^_]+_/, "")}·${m[2]}` : name;
}

function shortSummary(c: ToolCall): string {
  let s = c.summary;
  if (c.paths.length && (c.category === "read" || c.category === "edit")) {
    // Show just the file name for path-based tools; the drawer has the full path.
    s = s.replace(/[A-Za-z]:[\\/][^\s]*|\/[^\s]+/g, (p) => p.split(/[\\/]/).pop() ?? p);
  }
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}
