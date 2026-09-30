import { useMemo, useState } from "react";
import type { DailyCost } from "../../src/core/metrics.js";
import { byModelOrder, modelColor, modelLabel } from "./models.js";
import { Caption, formatUsd } from "./ui.js";

const parseDay = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

/** Every day from the first to the last, including days with no cost, so gaps show. */
function allDays(byDay: DailyCost): { date: Date; models: [string, number][]; total: number }[] {
  const keys = Object.keys(byDay).sort();
  if (!keys.length) return [];
  const out = [];
  const last = parseDay(keys.at(-1)!).getTime();
  for (let d = parseDay(keys[0]!); d.getTime() <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const models = byModelOrder(Object.entries(byDay[key] ?? {})).filter(([, c]) => c > 0);
    out.push({ date: d, models, total: models.reduce((s, [, c]) => s + c, 0) });
  }
  return out;
}

/** The next "round" value at or above v: 1, 2, 2.5 or 5 times a power of ten. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** Centred over the bar, but pinned to the plot's edge near either end. */
const tipPosition = (x: number): React.CSSProperties =>
  x < 0.12 ? { left: 0 } : x > 0.88 ? { right: 0 } : { left: `${x * 100}%`, transform: "translateX(-50%)" };

const fmtDay = (d: Date, weekday = false) =>
  d.toLocaleDateString(undefined, { ...(weekday ? { weekday: "short" } : {}), month: "short", day: "numeric" });

/** Cost per day as bars stacked by model. Hidden when everything happened on one day. */
export function DailyCostChart({ byDay }: { byDay: DailyCost }) {
  const days = useMemo(() => allDays(byDay), [byDay]);
  const [hover, setHover] = useState<number | null>(null);
  if (days.length < 2) return null;

  const total = days.reduce((s, d) => s + d.total, 0);
  const peak = days.reduce((a, b) => (b.total > a.total ? b : a));
  const top = niceCeil(peak.total);
  const active = days.filter((d) => d.total > 0).length;
  const h = hover === null ? undefined : days[hover];

  return (
    <figure className="daily">
      <figcaption className="daily-head">
        <Caption>Cost per day</Caption>
        <span className="stat-sub">
          {formatUsd(total / active)} a day on the {active} days with activity · most on {fmtDay(peak.date)}, {formatUsd(peak.total)}
        </span>
      </figcaption>
      <div className="daily-plot" onMouseLeave={() => setHover(null)}>
        <span className="daily-top" aria-hidden>
          {formatUsd(top)}
        </span>
        <div className="daily-bars" role="img" aria-label={`Cost per day from ${fmtDay(days[0]!.date)} to ${fmtDay(days.at(-1)!.date)}`}>
          {days.map((d, i) => (
            <div key={d.date.getTime()} className={`daily-col ${hover === i ? "hover" : ""}`} onMouseEnter={() => setHover(i)}>
              <div className="daily-stack" style={{ height: `${(d.total / top) * 100}%` }}>
                {d.models.map(([m, c]) => (
                  <span key={m} style={{ flexGrow: c, background: modelColor(m) }} />
                ))}
              </div>
            </div>
          ))}
        </div>
        {h && (
          <div className="daily-tip" style={tipPosition((hover! + 0.5) / days.length)} role="status">
            <div className="strong">
              {fmtDay(h.date, true)} · {formatUsd(h.total)}
            </div>
            {h.models.map(([m, c]) => (
              <div key={m} className="daily-tip-row">
                <span className="swatch" style={{ background: modelColor(m) }} aria-hidden />
                <span>{modelLabel(m)}</span>
                <span className="num">{formatUsd(c)}</span>
              </div>
            ))}
            {!h.models.length && <div className="muted">No activity</div>}
          </div>
        )}
      </div>
      <div className="daily-axis" aria-hidden>
        <span>{fmtDay(days[0]!.date)}</span>
        <span>{fmtDay(days.at(-1)!.date)}</span>
      </div>
    </figure>
  );
}
