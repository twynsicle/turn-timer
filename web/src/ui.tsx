import type { ReactNode } from "react";
import { formatUsd } from "../../src/core/cost.js";
import { pct } from "../../src/core/metrics.js";
import { byModelOrder, modelColor, modelLabel } from "./models.js";

export { formatMs, pct } from "../../src/core/metrics.js";
export { formatTokens, formatUsd } from "../../src/core/cost.js";

export function fmtDate(ms?: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** "Aug 1 – Sep 29, 2026": the year once when both ends share it, one date when they're the same day. */
export function fmtRange(from: number, to: number): string {
  const a = new Date(from);
  const b = new Date(to);
  const sameYear = a.getFullYear() === b.getFullYear();
  const end = b.toLocaleDateString(undefined, { ...DAY, year: "numeric" });
  if (sameYear && a.toDateString() === b.toDateString()) return end;
  return `${a.toLocaleDateString(undefined, sameYear ? DAY : { ...DAY, year: "numeric" })} – ${end}`;
}

export const projectName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

export type Tone = "muted" | "before" | "risk" | "suggestion" | "praise";

/** The one uppercase label: it varies only by tone. */
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

export function Stat({ label, value, sub, tone, children }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; children?: ReactNode }) {
  return (
    <div className="stat">
      <dt>
        <Caption>{label}</Caption>
      </dt>
      <dd className={`stat-value ${tone ? `tone-${tone}` : ""}`}>{value}</dd>
      {sub && <dd className="stat-sub">{sub}</dd>}
      {children && <dd>{children}</dd>}
    </div>
  );
}

const breakdown = (byModel: Record<string, number>, total: number) =>
  byModelOrder(Object.entries(byModel))
    .filter(([, c]) => c > 0)
    .map(([m, c]) => `${modelLabel(m)} ${formatUsd(c)} (${pct(c, total)})`)
    .join("\n");

/**
 * Cost as a bar split by model. `scale` is the cost that fills the track, so bars in a list
 * compare; it defaults to this bar's own total.
 */
export function ModelBar({ byModel, scale, height = 8 }: { byModel: Record<string, number>; scale?: number; height?: number }) {
  const total = Object.values(byModel).reduce((s, c) => s + c, 0);
  const full = scale || total;
  const parts = byModelOrder(Object.entries(byModel)).filter(([, c]) => c > 0);
  return (
    <span className="model-bar" style={{ height }} role="img" aria-label={breakdown(byModel, total).replaceAll("\n", ", ")} title={breakdown(byModel, total)}>
      <span className="model-bar-fill" style={{ width: full ? `${(total / full) * 100}%` : 0 }}>
        {parts.map(([m, c]) => (
          <span key={m} style={{ flexGrow: c, background: modelColor(m) }} />
        ))}
      </span>
    </span>
  );
}

/** Swatch, label and cost per model, in stacking order. */
export function ModelLegend({ byModel, compact }: { byModel: Record<string, number>; compact?: boolean }) {
  const total = Object.values(byModel).reduce((s, c) => s + c, 0);
  const rows = byModelOrder(Object.entries(byModel)).filter(([, c]) => c > 0);
  return (
    <ul className={`legend ${compact ? "compact" : ""}`}>
      {rows.map(([m, c]) => (
        <li key={m}>
          <span className="swatch" style={{ background: modelColor(m) }} aria-hidden />
          <span className="legend-label">{modelLabel(m)}</span>
          {!compact && (
            <>
              <span className="num strong">{formatUsd(c)}</span>
              <span className="num muted">{pct(c, total)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/*
 * Marks that sit on a row's first line, not its middle: each holds a zero-width space, so it has a
 * text baseline and a line box to centre in, and baseline-aligned rows put it on the first line.
 */
const ZWSP = "​";

export function ModelDot({ model }: { model: string }) {
  return (
    <span className="model-dot" style={{ color: modelColor(model) }} title={modelLabel(model)} aria-label={modelLabel(model)}>
      {ZWSP}
    </span>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <span className={`chevron ${open ? "open" : ""}`} aria-hidden>
      {ZWSP}
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, children }: { tabs: [T, string, number?][]; value: T; onChange: (t: T) => void; children?: ReactNode }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map(([k, label, n]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? "active" : ""} onClick={() => onChange(k)}>
          {label}
          {n !== undefined && <span className="tab-count">{n.toLocaleString()}</span>}
        </button>
      ))}
      {children && <div className="tab-tools">{children}</div>}
    </nav>
  );
}

export function Seg<T extends string>({ options, value, onChange, label }: { options: [T, string][]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={k} className={value === k ? "active" : ""} aria-pressed={value === k} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
    </div>
  );
}
