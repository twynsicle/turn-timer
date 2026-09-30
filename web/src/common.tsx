import { type ReactNode, useEffect, useState } from "react";
import { type Cost, type Tokens, contextTokens, formatTokens, formatUsd, turnCost } from "../../src/core/cost.js";
import { BUCKETS, formatMs, type ModelStat, pct, type RunTotals, type ToolStat, turnModelMs, turnOverheadMs } from "../../src/core/metrics.js";
import type { ToolCall, Turn } from "../../src/core/types.js";
import { api, type Detail } from "./api.js";

export { formatMs, formatTokens, formatUsd, pct };

export function fmtDate(ms?: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtSize(bytes: number): string {
  if (bytes < 1 << 20) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

/** Tone for a single-call ratio: lower is better. */
export function singleClass(single: number, total: number): string {
  if (!total) return "";
  const r = single / total;
  return r >= 0.5 ? "bad" : r >= 0.3 ? "warn" : "good";
}

export type Tone = "muted" | "before" | "risk" | "suggestion" | "praise";

/** The one uppercase label (diffy's Caption): it varies only by tone. */
export function Caption({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`caption tone-${tone}`}>{children}</span>;
}

/** Ruled section header: caption on the left, a mono count (or controls) on the right. */
export function SectionRule({ label, count, children }: { label: string; count?: number; children?: ReactNode }) {
  return (
    <header className="section-rule">
      <Caption>{label}</Caption>
      {children}
      {count !== undefined && <span className="section-count">{count.toLocaleString()}</span>}
    </header>
  );
}

export interface StatInput {
  turns: number;
  toolTurns: number;
  toolCalls: number;
  singleCallTurns: number;
  avgBatch: number;
  medianBatch: number;
  maxBatch: number;
  modelMs: number;
}

const TONE_OF: Record<string, Tone | undefined> = { bad: "risk", warn: "suggestion", good: "praise" };

export function Stats({ st, runs, extra }: { st: StatInput; runs?: RunTotals; extra?: { prompts?: number; reminders?: number } }) {
  return (
    <dl className="stats">
      <Stat label="Turns" value={st.turns.toLocaleString()} sub={extra?.prompts !== undefined ? `${extra.prompts} prompts` : undefined} />
      <Stat label="Tool calls" value={st.toolCalls.toLocaleString()} sub={`in ${st.toolTurns.toLocaleString()} tool turns`} />
      <Stat label="Avg per turn" value={st.avgBatch.toFixed(2)} sub={`median ${st.medianBatch} · max ${st.maxBatch}`} />
      <Stat
        label="Single-call turns"
        value={pct(st.singleCallTurns, st.toolTurns)}
        tone={TONE_OF[singleClass(st.singleCallTurns, st.toolTurns)]}
        sub={`${st.singleCallTurns.toLocaleString()} turns`}
      />
      {runs && (
        <>
          <Stat
            label="Likely batchable"
            value={String(runs.likely.runs)}
            tone={runs.likely.runs ? "risk" : undefined}
            sub={`${runs.likely.turns} extra round-trips · ~${formatMs(runs.likely.ms)} · ~${formatUsd(runs.likely.cost)}`}
          />
          <Stat
            label="Possibly batchable"
            value={String(runs.possibly.runs)}
            tone={runs.possibly.runs ? "suggestion" : undefined}
            sub={`${runs.possibly.turns} extra round-trips · ~${formatMs(runs.possibly.ms)} · ~${formatUsd(runs.possibly.cost)}`}
          />
        </>
      )}
      <Stat
        label="Model time"
        value={formatMs(st.modelMs)}
        sub={extra?.reminders ? `${extra.reminders} batching reminders from Claude Code` : "total response time"}
      />
    </dl>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div className="stat">
      <dt>
        <Caption>{label}</Caption>
      </dt>
      <dd className={`stat-value ${tone ? `tone-${tone}` : ""}`}>{value}</dd>
      {sub && <dd className="stat-sub">{sub}</dd>}
    </div>
  );
}

export interface CostInput {
  turns: number;
  tokens: Tokens;
  cost: Cost;
  unpricedTurns: number;
  peakContext: number;
  byModel: Record<string, ModelStat>;
}

const COST_PARTS: { key: keyof Omit<Cost, "total">; label: string; tokens?: keyof Tokens; hint: string }[] = [
  { key: "cacheRead", label: "Cache read", tokens: "cacheRead", hint: "Re-reading the cached context on every turn" },
  { key: "cacheWrite", label: "Cache write", tokens: "cacheWrite", hint: "Adding new content (tool results, messages) to the cache" },
  { key: "output", label: "Output", tokens: "output", hint: "Generated text, thinking and tool inputs" },
  { key: "input", label: "Input", tokens: "input", hint: "Uncached input" },
  { key: "webSearch", label: "Web search", hint: "Server-side web searches, $10 per 1,000" },
];

/** Estimated cost with a breakdown of where it went. */
export function CostPanel({ st, models = true }: { st: CostInput; models?: boolean }) {
  const c = st.cost;
  const parts = COST_PARTS.filter((p) => c[p.key] > 0);
  const modelRows = Object.entries(st.byModel).sort((a, b) => b[1].cost - a[1].cost);
  return (
    <section className="cost-panel" aria-label="Estimated cost">
      <SectionRule label="Estimated cost" />
      <div className="cost-total">{formatUsd(c.total)}</div>
      <div className="stat-sub">
        at API list prices{st.turns ? ` · ${formatUsd(c.total / st.turns)} per turn` : ""} · peak context {formatTokens(st.peakContext)}
      </div>
      {c.total > 0 && (
        <>
          <div className="cost-bar" role="img" aria-label={parts.map((p) => `${p.label} ${pct(c[p.key], c.total)}`).join(", ")}>
            {parts.map((p) => (
              <span key={p.key} className={`cost-seg seg-${p.key}`} style={{ width: `${(c[p.key] / c.total) * 100}%` }} title={`${p.label}: ${formatUsd(c[p.key])}`} />
            ))}
          </div>
          <div className="cost-rows">
            {parts.map((p) => (
              <div className="cost-row" key={p.key} title={p.hint}>
                <span className={`cost-swatch seg-${p.key}`} aria-hidden />
                <span>{p.label}</span>
                <span className="muted num">{p.tokens ? formatTokens(st.tokens[p.tokens]) : ""}</span>
                <span className="num strong">{formatUsd(c[p.key])}</span>
                <span className="muted num">{pct(c[p.key], c.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {models && modelRows.length > 1 && (
        <div className="cost-models">
          {modelRows.map(([name, m]) => (
            <div className="cost-row model" key={name}>
              <span className="mono ellipsis">{name}</span>
              <span className="muted num">{m.turns.toLocaleString()} turns</span>
              <span className="num strong">{m.priced ? formatUsd(m.cost) : <span className="warn">no price</span>}</span>
              <span className="muted num">{m.priced ? pct(m.cost, c.total) : ""}</span>
            </div>
          ))}
        </div>
      )}
      {st.unpricedTurns > 0 && <div className="small warn">{st.unpricedTurns.toLocaleString()} turns used models with no known price and aren't counted.</div>}
    </section>
  );
}

export function Histogram({ histogram, total }: { histogram: number[]; total: number }) {
  const max = Math.max(1, ...histogram);
  return (
    <section className="histogram" aria-label="Tool calls per turn">
      <SectionRule label="Tool calls per turn" />
      <div className="hist-rows">
        {BUCKETS.map((b, i) => (
          <div className="hist-row" key={b}>
            <span className="hist-label">{b}</span>
            <span className="hist-track">
              <span className={`hist-bar ${i === 0 ? "single" : ""}`} style={{ width: `${(histogram[i]! / max) * 100}%` }} />
            </span>
            <span className="hist-count">{histogram[i]!.toLocaleString()}</span>
            <span className="hist-pct">{pct(histogram[i]!, total)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ToolsTable({ byTool }: { byTool: Record<string, ToolStat> }) {
  const rows = Object.entries(byTool).sort((a, b) => b[1].calls - a[1].calls);
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Tool</th>
          <th className="r">Calls</th>
          <th className="r">Called alone</th>
          <th className="r">Alone %</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, t]) => (
          <tr key={name}>
            <td className="mono strong">{name}</td>
            <td className="r num">{t.calls.toLocaleString()}</td>
            <td className="r num">{t.soloTurns.toLocaleString()}</td>
            <td className={`r num strong ${singleClass(t.soloTurns, t.calls)}`}>{pct(t.soloTurns, t.calls)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface DetailTarget {
  call: ToolCall;
  turn: Turn;
  project: string;
  session: string;
}

export function DetailDrawer({ target, onClose }: { target: DetailTarget | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!target) return;
    let live = true;
    api
      .detail(target.project, target.session, target.call)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!target) return null;
  const { call, turn } = target;
  const toolMs = call.finishedAt ? call.finishedAt - call.startedAt : undefined;
  const cost = turnCost(turn);
  return (
    <aside className="drawer" aria-label="Tool call detail">
      <header className="drawer-head">
        <div>
          <Caption tone="before">Tool call</Caption>
          <div className="drawer-title">{call.name}</div>
          <div className="drawer-tags">
            <span className="tag">{call.category}</span>
            {call.readOnly && <span className="tag">read-only</span>}
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
        <dt>Calls in this turn</dt>
        <dd>{turn.toolCalls.length}</dd>
        <dt>Model time</dt>
        <dd>
          {formatMs(turnModelMs(turn))}
          <span className="muted">
            {" "}
            · {turn.usage.output.toLocaleString()} output tokens · ~{formatMs(turnOverheadMs(turn))} overhead
          </span>
        </dd>
        <dt>Turn cost</dt>
        <dd>
          {cost ? formatUsd(cost.total) : <span className="warn">no price for {turn.model}</span>}
          <span className="muted">
            {" "}
            · {formatTokens(contextTokens(turn.usage))} context · {turn.model}
            {turn.usage.fast ? " · fast mode" : ""}
          </span>
        </dd>
        <dt>Tool time</dt>
        <dd>{toolMs !== undefined ? formatMs(toolMs) : "–"}</dd>
        <dt>Depends on</dt>
        <dd>
          {call.refsBack
            ? `output from ${call.refsBack} turn${call.refsBack === 1 ? "" : "s"} earlier`
            : "nothing in recent results"}
        </dd>
      </dl>
      <div className="drawer-section">
        <SectionRule label="Input" />
        {error && <div className="error">{error}</div>}
        {!detail && !error && <div className="muted">Loading…</div>}
        {detail && <pre className="code">{formatInput(detail.input)}</pre>}
      </div>
      <div className="drawer-section">
        <SectionRule label="Result" />
        {detail &&
          (detail.result ? (
            <>
              <pre className={`code ${detail.result.isError ? "code-error" : ""}`}>{detail.result.text || "(empty)"}</pre>
              {detail.result.truncated && <div className="muted small">Truncated to 200,000 characters.</div>}
            </>
          ) : (
            <div className="muted">No result recorded.</div>
          ))}
      </div>
    </aside>
  );
}

function formatInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    // Show shell commands as-is rather than JSON-escaped.
    if (typeof o.command === "string" && Object.keys(o).every((k) => ["command", "description", "timeout"].includes(k))) {
      return o.command + (o.description ? `\n\n# ${o.description}` : "");
    }
  }
  return JSON.stringify(input, null, 2);
}
