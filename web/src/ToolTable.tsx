import { useState } from "react";
import type { ToolStat } from "../../src/core/metrics.js";
import { formatMs, pct } from "./ui.js";

type Sort = "time" | "calls" | "max";

/** Per-tool counts and run times. */
export function ToolTable({ byTool }: { byTool: Record<string, ToolStat> }) {
  const [sort, setSort] = useState<Sort>("time");
  const key: Record<Sort, (t: ToolStat) => number> = { time: (t) => t.totalMs, calls: (t) => t.calls, max: (t) => t.maxMs };
  const rows = Object.entries(byTool).sort((a, b) => key[sort](b[1]) - key[sort](a[1]));
  const totalMs = rows.reduce((s, [, t]) => s + t.totalMs, 0);
  const th = (k: Sort, label: string, title?: string) => (
    <th className="r" title={title} aria-sort={sort === k ? "descending" : undefined}>
      <button className={`th-sort ${sort === k ? "active" : ""}`} onClick={() => setSort(k)}>
        {label}
      </button>
    </th>
  );
  if (!rows.length) return <div className="empty">No tool calls.</div>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Tool</th>
          {th("calls", "Calls")}
          <th className="r">Errors</th>
          {th("time", "Total time", "Sum of every call's run time. Parallel calls overlap, and subagent calls run inside their Agent call.")}
          <th className="r">Share</th>
          <th className="r">Average</th>
          {th("max", "Slowest")}
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, t]) => (
          <tr key={name}>
            <td className="mono strong">{name}</td>
            <td className="r num">{t.calls.toLocaleString()}</td>
            <td className={`r num ${t.errors ? "bad" : "muted"}`}>{t.errors ? t.errors.toLocaleString() : "–"}</td>
            <td className="r num strong">{formatMs(t.totalMs)}</td>
            <td className="r num muted">{pct(t.totalMs, totalMs)}</td>
            <td className="r num">{formatMs(t.calls ? t.totalMs / t.calls : 0)}</td>
            <td className="r num">{formatMs(t.maxMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
