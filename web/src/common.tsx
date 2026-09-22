import { useEffect, useState } from "react";
import { BUCKETS, formatMs, pct, type RunTotals, type ToolStat, turnModelMs, turnOverheadMs } from "../../src/core/metrics.js";
import type { ToolCall, Turn } from "../../src/core/types.js";
import { api, type Detail } from "./api.js";

export { formatMs, pct };

export function fmtDate(ms?: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtSize(bytes: number): string {
  if (bytes < 1 << 20) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MB`;
}

/** Severity class for a single-call ratio: lower is better. */
export function singleClass(single: number, total: number): string {
  if (!total) return "";
  const r = single / total;
  return r >= 0.5 ? "bad" : r >= 0.3 ? "warn" : "good";
}

export interface TileStats {
  turns: number;
  toolTurns: number;
  toolCalls: number;
  singleCallTurns: number;
  avgBatch: number;
  medianBatch: number;
  maxBatch: number;
  modelMs: number;
}

export function Tiles({ st, runs, extra }: { st: TileStats; runs?: RunTotals; extra?: { prompts?: number; reminders?: number } }) {
  return (
    <div className="tiles">
      <Tile label="Turns" value={st.turns.toLocaleString()} sub={extra?.prompts !== undefined ? `${extra.prompts} prompts` : undefined} />
      <Tile label="Tool calls" value={st.toolCalls.toLocaleString()} sub={`in ${st.toolTurns.toLocaleString()} tool turns`} />
      <Tile label="Avg batch" value={st.avgBatch.toFixed(2)} sub={`median ${st.medianBatch} · max ${st.maxBatch}`} />
      <Tile
        label="Single-call turns"
        value={pct(st.singleCallTurns, st.toolTurns)}
        tone={singleClass(st.singleCallTurns, st.toolTurns)}
        sub={`${st.singleCallTurns.toLocaleString()} turns`}
      />
      {runs && (
        <>
          <Tile
            label="Likely batchable"
            value={`${runs.likely.runs}`}
            tone={runs.likely.runs ? "bad" : "good"}
            sub={`runs · ${runs.likely.turns} round-trips · ~${formatMs(runs.likely.ms)}`}
          />
          <Tile
            label="Possibly batchable"
            value={`${runs.possibly.runs}`}
            tone={runs.possibly.runs ? "warn" : "good"}
            sub={`runs · ${runs.possibly.turns} round-trips · ~${formatMs(runs.possibly.ms)}`}
          />
        </>
      )}
      <Tile
        label="Model time"
        value={formatMs(st.modelMs)}
        sub={extra?.reminders ? `${extra.reminders} batching reminders from Claude Code` : "sum of response latency"}
      />
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`tile ${tone ?? ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function Histogram({ histogram, total }: { histogram: number[]; total: number }) {
  const max = Math.max(1, ...histogram);
  return (
    <div className="histogram" role="table" aria-label="Tool calls per turn">
      <div className="hist-title">Tool calls per turn</div>
      {BUCKETS.map((b, i) => (
        <div className="hist-row" role="row" key={b}>
          <span className="hist-label">{b}</span>
          <span className="hist-track">
            <span className={`hist-bar ${i === 0 ? "single" : ""}`} style={{ width: `${(histogram[i]! / max) * 100}%` }} />
          </span>
          <span className="hist-count num">{histogram[i]!.toLocaleString()}</span>
          <span className="hist-pct num">{pct(histogram[i]!, total)}</span>
        </div>
      ))}
    </div>
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
          <th className="bar-col" />
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, t]) => (
          <tr key={name}>
            <td className="mono">{name}</td>
            <td className="r num">{t.calls.toLocaleString()}</td>
            <td className="r num">{t.soloTurns.toLocaleString()}</td>
            <td className={`r num ${singleClass(t.soloTurns, t.calls)}`}>{pct(t.soloTurns, t.calls)}</td>
            <td className="bar-col">
              <span className="mini-track">
                <span className="mini-bar" style={{ width: `${(t.soloTurns / Math.max(1, t.calls)) * 100}%` }} />
              </span>
            </td>
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
  return (
    <aside className="drawer" aria-label="Tool call detail">
      <header className="drawer-head">
        <div>
          <div className="drawer-title mono">{call.name}</div>
          <div className="drawer-sub">
            <span className={`cat cat-${call.category}`}>{call.category}</span>
            {call.readOnly && <span className="pill">read-only</span>}
            {call.isError && <span className="pill bad">error</span>}
            {call.denied && <span className="pill bad">denied</span>}
            {turn.agent.kind === "subagent" && <span className="pill agent">subagent: {turn.agent.agentType}</span>}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <dl className="facts">
        <dt>Turn batch</dt>
        <dd>
          {turn.toolCalls.length} call{turn.toolCalls.length === 1 ? "" : "s"} in this turn
        </dd>
        <dt>Model latency</dt>
        <dd>
          {formatMs(turnModelMs(turn))}
          <span className="muted"> · {turn.outputTokens.toLocaleString()} output tokens · ~{formatMs(turnOverheadMs(turn))} overhead</span>
        </dd>
        <dt>Tool time</dt>
        <dd>{toolMs !== undefined ? formatMs(toolMs) : "—"}</dd>
        <dt>Dependency</dt>
        <dd>
          {call.refsBack
            ? `mentions output from ${call.refsBack} turn${call.refsBack === 1 ? "" : "s"} earlier`
            : "no reference to recent results"}
        </dd>
      </dl>
      <h4>Input</h4>
      {error && <div className="error">{error}</div>}
      {!detail && !error && <div className="muted">Loading…</div>}
      {detail && <pre className="code">{formatInput(detail.input)}</pre>}
      <h4>Result</h4>
      {detail &&
        (detail.result ? (
          <>
            <pre className={`code ${detail.result.isError ? "code-error" : ""}`}>{detail.result.text || "(empty)"}</pre>
            {detail.result.truncated && <div className="muted">Truncated to 200,000 characters.</div>}
          </>
        ) : (
          <div className="muted">No result recorded.</div>
        ))}
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
