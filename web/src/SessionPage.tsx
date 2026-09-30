import { memo, useEffect, useMemo, useRef, useState } from "react";
import { contextTokens, turnCost } from "../../src/core/cost.js";
import { type CacheMiss, type SessionAnalysis, type Stats, analyzeSession, callMs, runSpanMs, runStats, turnModelMs, waitsOnUser } from "../../src/core/metrics.js";
import type { SessionRow } from "../../src/core/report-data.js";
import type { Prompt, Session, SubagentRun, ToolCall, ToolCategory, Turn } from "../../src/core/types.js";
import { useSession } from "./data.js";
import { modelLabel } from "./models.js";
import { DailyCostChart } from "./DailyCost.js";
import { ToolTable } from "./ToolTable.js";
import { Caption, Chevron, ModelBar, ModelDot, ModelLegend, SectionRule, Stat, Tabs, fmtDate, formatMs, formatTokens, formatUsd, pct, plural, projectName } from "./ui.js";

type Tab = "prompts" | "misses" | "slow" | "tools";

interface Located {
  call: ToolCall;
  turn: Turn;
  promptIndex: number;
}

interface Ctx {
  missByTurn: Map<string, CacheMiss>;
  focusTurn: string | null;
  selectedCall: string | null;
  onOpenCall: (id: string) => void;
}

export function SessionPage({ row, focusCall, onBack }: { row: SessionRow; focusCall?: string; onBack: () => void }) {
  const { session, error } = useSession(row.key);
  const title = row.title ?? row.firstPrompt ?? row.id;
  return (
    <article className="page">
      <header className="page-head">
        <button className="link back" onClick={onBack}>
          ← {projectName(row.project)}
        </button>
        <h1 title={title}>{title}</h1>
        <div className="page-meta">
          <span className="mono">{row.project}</span>
          <span className="dot">·</span>
          {fmtDate(row.startedAt)} → {fmtDate(row.endedAt)}
          <span className="dot">·</span>
          <span className="mono">{row.id.slice(0, 8)}</span>
        </div>
      </header>
      {error && <div className="notice tone-risk">{error}</div>}
      {!session && !error && <div className="loading">Loading session…</div>}
      {session && <SessionBody session={session} row={row} focusCall={focusCall} />}
    </article>
  );
}

const TTL_LABEL = { "1h": "1 hour", "5m": "5 minutes", mixed: "mixed", none: "unknown" };

function SessionBody({ session, row, focusCall }: { session: Session; row: SessionRow; focusCall?: string }) {
  const a: SessionAnalysis = useMemo(() => analyzeSession(session), [session]);
  const calls = useMemo(() => locateCalls(session), [session]);
  const st = a.total;

  const [tab, setTab] = useState<Tab>("prompts");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [focusTurn, setFocusTurn] = useState<string | null>(null);
  const [detail, setDetail] = useState<Located | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);

  const jump = (promptIndex: number, messageId: string) => {
    setTab("prompts");
    setExpanded((prev) => new Set(prev).add(promptIndex));
    setFocusTurn(messageId);
  };
  const open = (l: Located) => {
    setDetail(l);
    jump(l.promptIndex, l.turn.messageId);
  };

  useEffect(() => {
    const l = focusCall ? calls.get(focusCall) : undefined;
    if (l) open(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCall, calls]);

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const ctx: Ctx = {
    missByTurn: a.missByTurn,
    focusTurn,
    selectedCall: detail?.call.id ?? null,
    onOpenCall: (id) => {
      const l = calls.get(id);
      if (l) open(l);
    },
  };
  const prompts = session.prompts.filter((p) => !hideEmpty || a.prompts[p.index]!.turns > 0);
  const maxPromptCost = Math.max(0, ...a.prompts.map((p) => p.cost.total));
  const costByModel = Object.fromEntries(Object.entries(st.byModel).map(([m, s]) => [m, s.cost]));
  const wallMs = session.endedAt - session.startedAt;
  const expired = st.misses.filter((m) => m.kind === "expired");

  return (
    <div className={detail ? "with-drawer" : ""}>
      <section className="summary">
        <div className="cost-panel">
          <Caption>Estimated cost</Caption>
          <div className="cost-total">{formatUsd(st.cost.total)}</div>
          <div className="stat-sub">
            at API list prices · {st.turns ? `${formatUsd(st.cost.total / st.turns)} per turn` : ""} · peak context {formatTokens(st.peakContext)}
          </div>
          <ModelBar byModel={costByModel} height={12} />
          <ModelLegend byModel={costByModel} />
          {st.unpricedTurns > 0 && <div className="small warn">{plural(st.unpricedTurns, "turn")} used a model with no known price and aren't counted.</div>}
        </div>
        <dl className="stats">
          <Stat
            label="Time working"
            value={formatMs(st.activeMs)}
            sub={
              <>
                model {formatMs(st.modelMs)} · tools {formatMs(st.toolMs)}
                <br />
                {st.waitMs > 0 && `${formatMs(st.waitMs)} waiting on you · `}
                {formatMs(wallMs)} start to finish
              </>
            }
          />
          <Stat
            label="Turns"
            value={st.turns.toLocaleString()}
            sub={
              <>
                {plural(session.prompts.length, "prompt")} · {plural(st.toolCalls, "tool call")}
                {st.subagents > 0 && (
                  <>
                    <br />
                    {plural(st.subagents, "subagent")}
                  </>
                )}
              </>
            }
          />
          <Stat
            label="Cache misses"
            value={st.misses.length.toLocaleString()}
            sub={
              <>
                {st.misses.length ? `${formatUsd(st.missCost)} extra · ${pct(st.missCost, st.cost.total)} of cost` : "no context rebuilt"}
                <br />
                {expired.length > 0 && `${plural(expired.length, "expiry", "expiries")} · `}TTL {TTL_LABEL[st.ttl]}
              </>
            }
          />
        </dl>
        <DailyCostChart byDay={row.costByDay} />
      </section>

      <Tabs<Tab>
        tabs={[
          ["prompts", "Prompts", session.prompts.length],
          ["misses", "Cache misses", st.misses.length],
          ["slow", "Slowest tool calls"],
          ["tools", "Tools", Object.keys(st.byTool).length],
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === "prompts" && (
          <>
            <label>
              <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide prompts Claude didn't act on
            </label>
            <button className="link" onClick={() => setExpanded(new Set(prompts.map((p) => p.index)))}>
              Expand all
            </button>
            <button className="link" onClick={() => setExpanded(new Set())}>
              Collapse all
            </button>
          </>
        )}
      </Tabs>

      {tab === "prompts" && (
        <div className="prompts">
          <div className="prompt-row header" aria-hidden>
            <span className="r">#</span>
            <span>Prompt</span>
            <span className="r" title="From the prompt to Claude's last activity on it">
              Time
            </span>
            <span className="r">Turns</span>
            <span>Cost</span>
          </div>
          {prompts.map((p) => (
            <PromptBlock key={p.index} p={p} st={a.prompts[p.index]!} maxCost={maxPromptCost} open={expanded.has(p.index)} onToggle={() => toggle(p.index)} ctx={ctx} />
          ))}
          {!prompts.length && <div className="empty">No prompts.</div>}
        </div>
      )}
      {tab === "misses" && <MissTable misses={st.misses} session={session} onJump={jump} />}
      {tab === "slow" && <SlowTable st={st} calls={calls} onOpen={open} selected={detail?.call.id} />}
      {tab === "tools" && <ToolTable byTool={st.byTool} />}

      {detail && <Drawer target={detail} miss={a.missByTurn.get(detail.turn.messageId)} onClose={() => setDetail(null)} />}
    </div>
  );
}

function locateCalls(s: Session): Map<string, Located> {
  const out = new Map<string, Located>();
  const walk = (turns: Turn[], promptIndex: number) => {
    for (const turn of turns) {
      for (const call of turn.toolCalls) {
        out.set(call.id, { call, turn, promptIndex });
        if (call.subagent) walk(call.subagent.turns, promptIndex);
      }
    }
  };
  for (const p of s.prompts) {
    walk(p.turns, p.index);
    for (const r of p.detached ?? []) walk(r.turns, p.index);
  }
  return out;
}

const MISS_TEXT: Record<CacheMiss["kind"], string> = { expired: "cache expired", "model-switch": "model switch", invalidated: "cache reset" };

function MissTags({ misses }: { misses: CacheMiss[] }) {
  const byKind = new Map<CacheMiss["kind"], CacheMiss[]>();
  for (const m of misses) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
  return (
    <>
      {[...byKind].map(([kind, ms]) => (
        <span key={kind} className="tag tone-suggestion" title="Context the previous turn had cached was written again">
          {MISS_TEXT[kind]}
          {ms.length > 1 ? ` ×${ms.length}` : ""} · {formatUsd(ms.reduce((s, m) => s + m.cost, 0))}
        </span>
      ))}
    </>
  );
}

const PromptBlock = memo(function PromptBlock({
  p,
  st,
  maxCost,
  open,
  onToggle,
  ctx,
}: {
  p: Prompt;
  st: Stats;
  maxCost: number;
  open: boolean;
  onToggle: () => void;
  ctx: Ctx;
}) {
  const byModel = Object.fromEntries(Object.entries(st.byModel).map(([m, s]) => [m, s.cost]));
  return (
    <div className={`prompt ${open ? "open" : ""}`}>
      <button className="prompt-row" onClick={onToggle} aria-expanded={open}>
        <span className="r index">{String(p.index + 1).padStart(2, "0")}</span>
        <span className="prompt-text">
          <Chevron open={open} />
          <span className="prompt-body">
            <span className="prompt-tags">
              {p.kind === "notification" && <span className="tag">notification</span>}
              {p.kind === "command" && <span className="tag">command</span>}
              {p.interrupted && <span className="tag tone-suggestion">interrupted</span>}
              {p.compacted && <span className="tag">compacted</span>}
              <MissTags misses={st.misses} />
            </span>
            {!open && <span className="clamp">{p.text || "(empty)"}</span>}
          </span>
        </span>
        <span className="r num">{st.activeMs ? formatMs(st.activeMs) : <span className="muted">–</span>}</span>
        <span className="r num">{st.turns || <span className="muted">–</span>}</span>
        <span className="cost-cell">
          <ModelBar byModel={byModel} scale={maxCost} />
          <span className="num strong">{st.cost.total ? formatUsd(st.cost.total) : <span className="muted">–</span>}</span>
        </span>
      </button>
      {open && (
        <div className="prompt-open">
          <div className="prompt-full">{p.text || "(empty)"}</div>
          {st.turns > 0 && (
            <div className="prompt-facts">
              model {formatMs(st.modelMs)} · tools {formatMs(st.toolMs)} · {plural(st.toolCalls, "tool call")}
              {st.waitMs > 0 && ` · ${formatMs(st.waitMs)} waiting on you`}
              {st.subagents > 0 && ` · ${plural(st.subagents, "subagent")}`}
            </div>
          )}
          {p.turns.length > 0 && <TurnList turns={p.turns} ctx={ctx} />}
          {p.detached?.map((r) => <SubagentBlock key={r.agentId} run={r} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
});

function TurnList({ turns, ctx }: { turns: Turn[]; ctx: Ctx }) {
  return (
    <div className="turn-list">
      <div className="turn turn-header" aria-hidden>
        <span className="r">Turn</span>
        <span />
        <span className="step step-head">
          <span />
          <span>Tool</span>
          <span>Input</span>
          <span className="r">Tool time</span>
        </span>
        <span className="r" title="From the previous result (or the prompt) to the end of the response">
          Model time
        </span>
        <span className="r">Cost</span>
      </div>
      {turns.map((t, i) => (
        <TurnBlock key={t.messageId} t={t} index={i + 1} ctx={ctx} />
      ))}
    </div>
  );
}

function TurnBlock({ t, index, ctx }: { t: Turn; index: number; ctx: Ctx }) {
  const miss = ctx.missByTurn.get(t.messageId);
  return (
    <>
      {miss && <MissRow miss={miss} />}
      <TurnRow t={t} index={index} ctx={ctx} />
      {t.toolCalls
        .filter((c) => c.subagent)
        .map((c) => (
          <SubagentBlock key={c.id} run={c.subagent!} call={c} ctx={ctx} />
        ))}
    </>
  );
}

const ttlText = (ms: number) => (ms >= 3_600_000 ? "1 hour" : `${Math.round(ms / 60_000)} minute`);

function missExplanation(m: CacheMiss): string {
  const rebuilt = `Rewrote ${formatTokens(m.rebuiltTokens)} tokens of context: ${formatUsd(m.cost)} more than reading them from the cache.`;
  if (m.kind === "expired") return `${formatMs(m.gapMs)} since the previous request, past the ${ttlText(m.ttlMs)} cache lifetime. ${rebuilt}`;
  if (m.kind === "model-switch") return `Switched from ${modelLabel(m.prevModel)} to ${modelLabel(m.model)}; each model has its own cache. ${rebuilt}`;
  return `Only ${formatMs(m.gapMs)} after the previous request, within the ${ttlText(m.ttlMs)} lifetime, so something earlier in the context changed. ${rebuilt}`;
}

function MissRow({ miss }: { miss: CacheMiss }) {
  return (
    <div className="miss-row">
      <Caption tone="suggestion">{MISS_TEXT[miss.kind]}</Caption>
      <span className="miss-text">{missExplanation(miss)}</span>
    </div>
  );
}

const CAT_LETTER: Record<ToolCategory, string> = { read: "R", edit: "E", exec: "$", agent: "A", mcp: "M", other: "·" };
const CAT_TITLE: Record<ToolCategory, string> = {
  read: "Reads",
  edit: "Edits files",
  exec: "Shell command",
  agent: "Starts a subagent",
  mcp: "MCP tool",
  other: "Other tool",
};

function TurnRow({ t, index, ctx }: { t: Turn; index: number; ctx: Ctx }) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = ctx.focusTurn === t.messageId;
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  const cost = turnCost(t);
  return (
    <div ref={ref} className={`turn ${focused ? "focused" : ""}`}>
      <span className="turn-idx">{String(index).padStart(2, "0")}</span>
      <ModelDot model={t.model} />
      <ul className="steps">
        {t.toolCalls.length === 0 && <li className="step-none">{t.hasText ? "Replied, no tools" : "Thinking only, no tools"}</li>}
        {t.toolCalls.map((c) => (
          <li key={c.id}>
            <button
              className={`step ${ctx.selectedCall === c.id ? "selected" : ""}`}
              title={`${c.name}: ${c.summary}`}
              onClick={() => ctx.onOpenCall(c.id)}
            >
              <span className={`step-cat cat-${c.category}`} title={CAT_TITLE[c.category]}>
                {CAT_LETTER[c.category]}
              </span>
              <span className={`step-name ${c.denied ? "denied" : ""}`}>{shortName(c.name)}</span>
              <span className="step-sum">
                {c.isError && <span className="tag tone-risk">error</span>}
                {c.denied && <span className="tag tone-risk">denied</span>}
                {c.summary || <span className="muted">(no input)</span>}
              </span>
              <span className={`step-time ${waitsOnUser(c) ? "muted" : ""}`} title={waitsOnUser(c) ? "Waiting on your answer; not counted as working time" : undefined}>
                {c.finishedAt ? formatMs(callMs(c)) : "–"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <span className="turn-num">{formatMs(turnModelMs(t))}</span>
      <span className="turn-num" title={`${formatTokens(contextTokens(t.usage))} context · ${t.usage.output.toLocaleString()} output tokens · ${modelLabel(t.model)}`}>
        {cost ? formatUsd(cost.total) : "–"}
      </span>
    </div>
  );
}

function SubagentBlock({ run, call, ctx }: { run: SubagentRun; call?: ToolCall; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const st = useMemo(() => runStats(run, ctx.missByTurn), [run, ctx.missByTurn]);
  useEffect(() => {
    if (ctx.focusTurn && containsTurn(run.turns, ctx.focusTurn)) setOpen(true);
  }, [ctx.focusTurn, run]);
  // Not the Agent call's time: a background agent's call returns as soon as it starts.
  const ms = useMemo(() => runSpanMs(run), [run]);
  return (
    <aside className="subagent">
      <button className="subagent-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="subagent-title">
          <Chevron open={open} />
          <Caption tone="before">
            {call ? "Subagent" : "Unlinked subagent"} · {run.agentType}
          </Caption>
        </span>
        <span className="subagent-desc">{run.description}</span>
        <span className="subagent-stats">
          {ms > 0 && `${formatMs(ms)} · `}
          {plural(st.turns, "turn")} · {plural(st.toolCalls, "call")} · <span className="strong">{formatUsd(st.cost.total)}</span>
          {st.misses.length > 0 && <span className="warn"> · {plural(st.misses.length, "cache miss", "cache misses")}</span>}
        </span>
      </button>
      {open && <TurnList turns={run.turns} ctx={ctx} />}
    </aside>
  );
}

function containsTurn(turns: Turn[], id: string): boolean {
  return turns.some((t) => t.messageId === id || t.toolCalls.some((c) => c.subagent && containsTurn(c.subagent.turns, id)));
}

function MissTable({ misses, session, onJump }: { misses: CacheMiss[]; session: Session; onJump: (promptIndex: number, messageId: string) => void }) {
  if (!misses.length) return <div className="empty">No cache misses: every turn read the previous turn's context from the cache.</div>;
  const sorted = [...misses].sort((a, b) => b.cost - a.cost);
  return (
    <>
      <p className="prose muted">
        Turns that had to write context again that the previous turn had cached. Writing costs more than reading from the cache (1.25× the input rate
        for the 5-minute cache, 2× for the 1-hour one, against 0.05–0.1× for a read), so a long session that goes cold pays for its whole context
        again. <b>Expired</b>: the gap since the previous request outlasted the cache. <b>Model switch</b>: each model has its own cache.{" "}
        <b>Reset</b>: within the lifetime on the same model, so something earlier in the context changed.
      </p>
      <table className="grid clickable">
        <thead>
          <tr>
            <th>What</th>
            <th className="r">Prompt</th>
            <th>Where</th>
            <th className="r">Gap</th>
            <th className="r">Cache lifetime</th>
            <th className="r">Rewritten</th>
            <th className="r">Extra cost</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={m.messageId} onClick={() => onJump(m.promptIndex, m.messageId)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onJump(m.promptIndex, m.messageId)}>
              <td>
                <span className="tag tone-suggestion">{MISS_TEXT[m.kind]}</span>
              </td>
              <td className="r num" title={session.prompts[m.promptIndex]?.text.slice(0, 300)}>
                {String(m.promptIndex + 1).padStart(2, "0")}
              </td>
              <td className={m.agent.kind === "main" ? "muted" : undefined}>{m.agent.kind === "main" ? "main" : m.agent.agentType}</td>
              <td className="r num">{formatMs(m.gapMs)}</td>
              <td className="r num muted">{ttlText(m.ttlMs)}</td>
              <td className="r num">{formatTokens(m.rebuiltTokens)}</td>
              <td className="r num strong">{formatUsd(m.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SlowTable({ st, calls, onOpen, selected }: { st: Stats; calls: Map<string, Located>; onOpen: (l: Located) => void; selected?: string }) {
  if (!st.slowest.length) return <div className="empty">No tool calls.</div>;
  return (
    <table className="grid clickable fit">
      <thead>
        <tr>
          <th className="r">Time</th>
          <th>Tool</th>
          <th>Input</th>
          <th className="r">Prompt</th>
        </tr>
      </thead>
      <tbody>
        {st.slowest.map((c) => {
          const l = calls.get(c.id);
          return (
            <tr key={c.id} className={selected === c.id ? "selected" : ""} onClick={() => l && onOpen(l)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && l && onOpen(l)}>
              <td className="r num strong nowrap">{formatMs(c.ms)}</td>
              <td className="nowrap">
                <span className="strong">{shortName(c.name)}</span>
                {c.agentType && <span className="tag tone-before">{c.agentType}</span>}
                {c.isError && <span className="tag tone-risk">error</span>}
              </td>
              <td className="ellipsis-cell mono" title={c.summary}>
                {c.summary}
              </td>
              <td className="r num">{String(c.promptIndex + 1).padStart(2, "0")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Drawer({ target, miss, onClose }: { target: Located; miss?: CacheMiss; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const { call, turn } = target;
  const cost = turnCost(turn);
  return (
    <aside className="drawer" aria-label="Tool call detail">
      <header className="drawer-head">
        <div>
          <Caption tone="before">Tool call</Caption>
          <div className="drawer-title">{call.name}</div>
          <div className="drawer-tags">
            <span className="tag">{CAT_TITLE[call.category]}</span>
            {call.isError && <span className="tag tone-risk">error</span>}
            {call.denied && <span className="tag tone-risk">denied</span>}
            {turn.agent.kind === "subagent" && <span className="tag tone-before">subagent: {turn.agent.agentType}</span>}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <dl className="facts">
        <dt>{waitsOnUser(call) ? "Waited on you" : "Tool time"}</dt>
        <dd>{call.finishedAt ? formatMs(callMs(call)) : "no result recorded"}</dd>
        <dt>Model time</dt>
        <dd>
          {formatMs(turnModelMs(turn))}
          <span className="muted"> · {turn.usage.output.toLocaleString()} output tokens</span>
        </dd>
        <dt>Turn cost</dt>
        <dd>
          {cost ? formatUsd(cost.total) : <span className="warn">no price for {turn.model}</span>}
          <span className="muted">
            {" "}
            · {formatTokens(contextTokens(turn.usage))} context · {modelLabel(turn.model)}
            {turn.usage.fast ? " · fast mode" : ""}
          </span>
        </dd>
        <dt>Result</dt>
        <dd>{call.resultChars !== undefined ? `${call.resultChars.toLocaleString()} characters` : "none recorded"}</dd>
        <dt>Calls in turn</dt>
        <dd>{turn.toolCalls.length}</dd>
        {miss && (
          <>
            <dt className="warn">Cache miss</dt>
            <dd>{missExplanation(miss)}</dd>
          </>
        )}
      </dl>
      <div className="drawer-section">
        <SectionRule label="Input" />
        <pre className="code">{call.input || "(none)"}</pre>
      </div>
    </aside>
  );
}

function shortName(name: string): string {
  // mcp__server__tool → server·tool
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]!.replace(/^plugin_[^_]+_/, "")}·${m[2]}` : name;
}
