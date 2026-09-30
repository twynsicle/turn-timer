// Model identity: a label and a fixed color slot per model.
//
// Colors come from the validated categorical palette (--series-1..8 in styles.css). The slot
// follows the model, never its rank, so a model keeps its color across sessions and filters.
// Stacked bars draw models in slot order, the order the palette was validated for.

import { normalizeModel } from "../../src/core/cost.js";

const SLOTS: [string, number][] = [
  ["claude-opus-5-5", 1],
  ["claude-sonnet-5-5", 2],
  ["claude-haiku-4-5", 3],
  ["claude-fable-5-1", 4],
  ["claude-mythos-5-1", 4],
  ["claude-opus-5", 5],
  ["claude-sonnet-5", 6],
  ["claude-fable-5", 7],
  ["claude-mythos-5", 7],
  ["claude-opus-4-8", 8],
];
const SLOT = new Map(SLOTS);
/** Models without a slot share a neutral "other" color, drawn last. */
const OTHER = 9;

export const modelSlot = (model: string) => SLOT.get(normalizeModel(model)) ?? OTHER;

export const modelColor = (model: string) => {
  const slot = modelSlot(model);
  return slot === OTHER ? "var(--series-other)" : `var(--series-${slot})`;
};

/** "claude-opus-5-5-20260101" → "Opus 5.5". */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(normalizeModel(model));
  if (!m) return model || "unknown";
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Entries sorted into stacking order (by slot, then name). */
export function byModelOrder<T>(entries: [string, T][]): [string, T][] {
  return [...entries].sort((a, b) => modelSlot(a[0]) - modelSlot(b[0]) || a[0].localeCompare(b[0]));
}
