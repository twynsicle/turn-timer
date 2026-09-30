// Token pricing and cost estimates. Pure (no Node imports) — shared with the web viewer.
//
// Rates are Anthropic first-party API list prices in USD per million tokens. They estimate
// what a session would cost at API rates; on a Pro/Max subscription nothing is billed per
// token, but the numbers still rank sessions by how much usage they consumed.

import type { Turn, Usage } from "./types.js";

export interface ModelPrice {
  input: number;
  output: number;
  /** Cache read rate. Usually 0.1× input, but some models price it lower. */
  cacheRead: number;
}

/** Cache writes are priced relative to the input rate. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
/** Fast mode (Opus) is priced at 2× the standard rates. */
export const FAST_MULTIPLIER = 2;
/** Server-side web search: $10 per 1,000 searches. */
export const WEB_SEARCH_USD = 0.01;

const p = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({ input, output, cacheRead });

/** Keyed by model id without any date suffix; `priceOf` also accepts dated and provider-prefixed ids. */
export const PRICING: Record<string, ModelPrice> = {
  "claude-fable-5-1": p(10, 50, 0.25),
  "claude-mythos-5-1": p(10, 50, 0.25),
  "claude-fable-5": p(10, 50),
  "claude-mythos-5": p(10, 50),
  "claude-opus-5-5": p(4, 20, 0.2),
  "claude-opus-5": p(5, 25),
  "claude-opus-4-8": p(5, 25),
  "claude-opus-4-7": p(5, 25),
  "claude-opus-4-6": p(5, 25),
  "claude-opus-4-5": p(5, 25),
  "claude-opus-4-1": p(15, 75),
  "claude-opus-4": p(15, 75),
  "claude-sonnet-5-5": p(2, 10),
  "claude-sonnet-5": p(2, 10),
  "claude-sonnet-4-6": p(3, 15),
  "claude-sonnet-4-5": p(3, 15),
  "claude-sonnet-4": p(3, 15),
  "claude-haiku-4-5": p(1, 5),
  "claude-3-5-haiku": p(0.8, 4),
};

/**
 * Price for a model id. Accepts exact ids, ids with a date suffix (claude-haiku-4-5-20251001),
 * provider prefixes (us.anthropic.claude-…), Vertex "@date" suffixes and "[1m]" tags.
 * An unknown version (claude-opus-4-9) is not matched to a sibling; it returns undefined.
 */
export function priceOf(model: string): ModelPrice | undefined {
  return PRICING[normalizeModel(model)];
}

/** A model id without provider prefixes, date or version suffixes and "[1m]"-style tags. */
export function normalizeModel(model: string): string {
  return model
    .replace(/^.*?(?=claude-)/, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/@.*$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}

export interface Tokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface Cost {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  webSearch: number;
  total: number;
}

export const zeroTokens = (): Tokens => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
export const zeroCost = (): Cost => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, webSearch: 0, total: 0 });

export const emptyUsage = (): Usage => ({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, webSearches: 0, fast: false });

/** Everything the model read for this turn: the context size at that point. */
export const contextTokens = (u: Usage) => u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;

/** Cost of one turn, or undefined when the model has no known price. */
export function turnCost(t: Turn): Cost | undefined {
  const price = priceOf(t.model);
  if (!price) return undefined;
  const u = t.usage;
  const m = (u.fast ? FAST_MULTIPLIER : 1) / 1e6;
  const c: Cost = {
    input: u.input * price.input * m,
    cacheWrite: (u.cacheWrite5m * CACHE_WRITE_5M + u.cacheWrite1h * CACHE_WRITE_1H) * price.input * m,
    cacheRead: u.cacheRead * price.cacheRead * m,
    output: u.output * price.output * m,
    webSearch: u.webSearches * WEB_SEARCH_USD,
    total: 0,
  };
  c.total = c.input + c.cacheWrite + c.cacheRead + c.output + c.webSearch;
  return c;
}

/**
 * What it cost to write `tokens` to the cache instead of reading them: the turn's write rate
 * (its own 5-minute / 1-hour mix) minus the read rate. The price of a cache miss.
 */
export function rebuildCost(t: Turn, tokens: number): number {
  const price = priceOf(t.model);
  if (!price) return 0;
  const u = t.usage;
  const written = u.cacheWrite5m + u.cacheWrite1h;
  const writeMult = written ? (u.cacheWrite5m * CACHE_WRITE_5M + u.cacheWrite1h * CACHE_WRITE_1H) / written : CACHE_WRITE_5M;
  return (tokens * (price.input * writeMult - price.cacheRead) * (u.fast ? FAST_MULTIPLIER : 1)) / 1e6;
}

export function addCost(a: Cost, b: Cost): void {
  a.input += b.input;
  a.cacheWrite += b.cacheWrite;
  a.cacheRead += b.cacheRead;
  a.output += b.output;
  a.webSearch += b.webSearch;
  a.total += b.total;
}

export function addTokens(a: Tokens, b: Tokens): void {
  a.input += b.input;
  a.cacheWrite += b.cacheWrite;
  a.cacheRead += b.cacheRead;
  a.output += b.output;
}

export const usageTokens = (u: Usage): Tokens => ({
  input: u.input,
  cacheWrite: u.cacheWrite5m + u.cacheWrite1h,
  cacheRead: u.cacheRead,
  output: u.output,
});

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 10e6 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}
