import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { cap, classify, inputText } from "./classify.js";
import { subagentFiles } from "./discover.js";
import { readLines, tryParse } from "./lines.js";
import { INTERRUPT_PREFIX, NO_PROMPT, blocks, hasToolResults, promptTextOf, toolResultText, ts, userText } from "./records.js";
import { emptyUsage } from "./cost.js";
import type { AgentRef, Prompt, Session, SubagentRun, ToolCall, Turn, Usage } from "./types.js";

/** Cap on the result text kept per call. */
const RESULT_CAP = 1000;

interface StreamState {
  agent: AgentRef;
  turns: Turn[];
  turnsById: Map<string, Turn>;
  pending: Map<string, ToolCall>;
  lastEventAt: number;
}

interface SessionState {
  cwd: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  prompts: Prompt[];
  current?: Prompt;
  /** Old-style subagent records inline in the main file (isSidechain), one stream per prompt. */
  sidechains: Map<Prompt, StreamState>;
}

function newStream(agent: AgentRef): StreamState {
  return { agent, turns: [], turnsById: new Map(), pending: new Map(), lastEventAt: 0 };
}

function handleAssistant(rec: any, st: StreamState): Turn | undefined {
  const msg = rec.message;
  if (!msg || msg.model === "<synthetic>") return undefined;
  const id: string = msg.id ?? rec.uuid;
  const at = ts(rec);
  let turn = st.turnsById.get(id);
  let isNew = false;
  if (!turn) {
    isNew = true;
    turn = {
      messageId: id,
      agent: st.agent,
      requestedAt: st.lastEventAt || at,
      respondedAt: at,
      model: msg.model ?? "",
      toolCalls: [],
      hasText: false,
      hasThinking: false,
      usage: emptyUsage(),
    };
    st.turnsById.set(id, turn);
    st.turns.push(turn);
  }
  if (at > turn.respondedAt) turn.respondedAt = at;
  if (msg.usage) mergeUsage(turn.usage, msg.usage);

  for (const b of blocks(rec)) {
    if (b?.type === "text" && b.text?.trim()) turn.hasText = true;
    else if (b?.type === "thinking" || b?.type === "redacted_thinking") turn.hasThinking = true;
    else if (b?.type === "tool_use") {
      const c = classify(b.name, b.input);
      const call: ToolCall = {
        id: b.id,
        name: b.name,
        category: c.category,
        summary: c.summary,
        input: inputText(b.input),
        startedAt: at,
        isError: false,
        denied: false,
      };
      turn.toolCalls.push(call);
      st.pending.set(b.id, call);
    }
  }
  return isNew ? turn : undefined;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Fold one record's `usage` into the turn's. Every content block of a response is its own
 * record and each repeats the response's usage, so take the max per field, not the sum.
 */
function mergeUsage(u: Usage, raw: any) {
  const written = num(raw.cache_creation_input_tokens);
  const oneHour = num(raw.cache_creation?.ephemeral_1h_input_tokens);
  // Without the TTL breakdown, treat every write as the 5-minute kind.
  const fiveMin = raw.cache_creation ? num(raw.cache_creation.ephemeral_5m_input_tokens) : written;
  u.input = Math.max(u.input, num(raw.input_tokens));
  u.cacheWrite5m = Math.max(u.cacheWrite5m, fiveMin);
  u.cacheWrite1h = Math.max(u.cacheWrite1h, oneHour);
  u.cacheRead = Math.max(u.cacheRead, num(raw.cache_read_input_tokens));
  u.output = Math.max(u.output, num(raw.output_tokens));
  u.webSearches = Math.max(u.webSearches, num(raw.server_tool_use?.web_search_requests));
  if (raw.speed === "fast") u.fast = true;
}

function handleToolResults(rec: any, st: StreamState) {
  const at = ts(rec);
  for (const b of blocks(rec)) {
    if (b?.type !== "tool_result") continue;
    const call = st.pending.get(b.tool_use_id);
    if (!call) continue;
    st.pending.delete(b.tool_use_id);
    call.finishedAt = at;
    call.isError = b.is_error === true;
    if (rec.toolDenialKind) call.denied = true;
    const text = toolResultText(b) || (Array.isArray(b.content) && b.content.length ? "[non-text result]" : "");
    call.result = cap(text, RESULT_CAP);
    call.resultChars = text.length;
  }
  if (at) st.lastEventAt = at;
}

function currentPrompt(ss: SessionState, at: number): Prompt {
  if (!ss.current) {
    ss.current = {
      id: "",
      index: ss.prompts.length,
      kind: "user",
      text: NO_PROMPT,
      startedAt: at,
      interrupted: false,
      compacted: false,
      turns: [],
    };
    ss.prompts.push(ss.current);
  }
  return ss.current;
}

function handleUserText(rec: any, ss: SessionState) {
  const at = ts(rec);
  const pid: string | undefined = rec.promptId;
  const parsed = promptTextOf(rec);
  // Only a record with prompt text starts a prompt. Claude Code sometimes tags later records
  // (interrupts, compact summaries, meta) with an earlier prompt's id; a changed id alone
  // would open a prompt with no text, so those records stay with the current prompt.
  const startsNew = parsed !== undefined && !(pid && pid === ss.current?.id);
  if (startsNew) {
    ss.current = {
      id: pid ?? rec.uuid ?? String(ss.prompts.length),
      index: ss.prompts.length,
      kind: parsed.kind,
      text: parsed.text,
      startedAt: at,
      interrupted: false,
      compacted: false,
      turns: [],
    };
    ss.prompts.push(ss.current);
  } else if (ss.current?.kind === "command" && parsed?.kind === "user") {
    // e.g. "/model" followed by "continue" under the same promptId
    ss.current.text = `${ss.current.text} → ${parsed.text}`;
  }
  const p = currentPrompt(ss, at);
  if (rec.isCompactSummary) p.compacted = true;
  if (userText(rec).trim().startsWith(INTERRUPT_PREFIX)) p.interrupted = true;
}

/**
 * A resumed session's log starts with a copy of the history it resumed, records and uuids
 * unchanged (one log here repeats its opening 15 times). Only a record's first copy counts.
 */
function firstCopy(rec: any, seen: Set<string>): boolean {
  if (typeof rec.uuid !== "string") return true;
  if (seen.has(rec.uuid)) return false;
  seen.add(rec.uuid);
  return true;
}

async function parseMainFile(path: string, st: StreamState, ss: SessionState) {
  const seen = new Set<string>();
  for await (const line of readLines(path)) {
    const rec = tryParse(line.text);
    if (!rec || !firstCopy(rec, seen)) continue;
    const at = ts(rec);
    if (rec.isSidechain) {
      handleSidechain(rec, ss, at);
      continue;
    }
    if (at) {
      if (!ss.startedAt || at < ss.startedAt) ss.startedAt = at;
      if (at > ss.endedAt) ss.endedAt = at;
    }
    if (!ss.cwd && typeof rec.cwd === "string") ss.cwd = rec.cwd;
    switch (rec.type) {
      case "assistant": {
        const turn = handleAssistant(rec, st);
        if (turn) currentPrompt(ss, at).turns.push(turn);
        break;
      }
      case "user":
        if (hasToolResults(rec)) {
          handleToolResults(rec, st);
          // Text riding along with results never starts a prompt; an interrupt note still counts.
          if (ss.current && userText(rec).trim().startsWith(INTERRUPT_PREFIX)) ss.current.interrupted = true;
        } else {
          handleUserText(rec, ss);
          if (at) st.lastEventAt = at;
        }
        break;
      case "system":
        if (rec.subtype === "compact_boundary" && ss.current) ss.current.compacted = true;
        break;
      case "custom-title":
        if (rec.customTitle) ss.title = rec.customTitle;
        break;
    }
  }
}

const SIDECHAIN = { kind: "subagent" as const, agentId: "sidechain", agentType: "sidechain", description: "Subagent logged in the main file", depth: 1 };

function handleSidechain(rec: any, ss: SessionState, at: number) {
  const p = currentPrompt(ss, at);
  let st = ss.sidechains.get(p);
  if (!st) ss.sidechains.set(p, (st = newStream(SIDECHAIN)));
  if (rec.type === "assistant") handleAssistant(rec, st);
  else if (rec.type === "user") {
    if (hasToolResults(rec)) handleToolResults(rec, st);
    else if (at) st.lastEventAt = at;
  }
}

async function parseSubagentFile(path: string, st: StreamState) {
  const seen = new Set<string>();
  for await (const line of readLines(path)) {
    const rec = tryParse(line.text);
    if (!rec || !firstCopy(rec, seen)) continue;
    if (rec.type === "assistant") handleAssistant(rec, st);
    else if (rec.type === "user") {
      if (hasToolResults(rec)) handleToolResults(rec, st);
      else if (ts(rec)) st.lastEventAt = ts(rec);
    }
  }
}

interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

async function readMeta(jsonlPath: string): Promise<SubagentMeta> {
  try {
    return JSON.parse(await readFile(jsonlPath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return {};
  }
}

export async function parseSession(path: string): Promise<Session> {
  const main = newStream({ kind: "main" });
  const ss: SessionState = { cwd: "", startedAt: 0, endedAt: 0, prompts: [], sidechains: new Map() };
  await parseMainFile(path, main, ss);

  // Subagents: parse each file, then attach to the Agent tool call that spawned it.
  const runsByToolUse = new Map<string, SubagentRun>();
  const unlinked: SubagentRun[] = [];
  for (const f of await subagentFiles(path)) {
    const meta = await readMeta(f);
    const agentId = basename(f, ".jsonl").replace(/^agent-/, "");
    const agent: AgentRef = {
      kind: "subagent",
      agentId,
      agentType: meta.agentType ?? "subagent",
      description: meta.description ?? "",
      depth: meta.spawnDepth ?? 1,
    };
    const st = newStream(agent);
    await parseSubagentFile(f, st);
    const run: SubagentRun = {
      agentId,
      agentType: agent.agentType,
      description: agent.description,
      depth: agent.depth,
      turns: st.turns,
    };
    if (!run.turns.length) continue;
    if (meta.toolUseId) runsByToolUse.set(meta.toolUseId, run);
    else unlinked.push(run);
  }
  const attach = (turns: Turn[]) => {
    for (const t of turns) {
      for (const c of t.toolCalls) {
        const run = runsByToolUse.get(c.id);
        if (run && !c.subagent) {
          c.subagent = run;
          runsByToolUse.delete(c.id);
          attach(run.turns);
        }
      }
    }
  };
  for (const p of ss.prompts) attach(p.turns);

  // Subagent work that can't be tied to the call that spawned it still counts: file it
  // under the prompt that was running when it started.
  const detach = (run: SubagentRun) => {
    const start = run.turns[0]!.requestedAt;
    const p = ss.prompts.findLast((q) => q.startedAt <= start) ?? ss.prompts[0] ?? currentPrompt(ss, start);
    (p.detached ??= []).push(run);
  };
  for (const [p, st] of ss.sidechains) {
    if (st.turns.length) (p.detached ??= []).push({ agentId: "sidechain", agentType: "sidechain", description: SIDECHAIN.description, depth: 1, turns: st.turns });
  }
  for (const run of unlinked) {
    detach(run);
    attach(run.turns);
  }
  // Shallowest first, so a detached parent picks up its own children.
  for (const [id, run] of [...runsByToolUse].sort((a, b) => a[1].depth - b[1].depth)) {
    if (!runsByToolUse.delete(id)) continue;
    detach(run);
    attach(run.turns);
  }

  return {
    id: basename(path, ".jsonl"),
    projectDir: basename(dirname(path)),
    cwd: ss.cwd,
    title: ss.title,
    startedAt: ss.startedAt,
    endedAt: ss.endedAt,
    prompts: ss.prompts,
  };
}

export function sessionPath(projectsRoot: string, projectDir: string, sessionId: string): string {
  return join(projectsRoot, projectDir, `${sessionId}.jsonl`);
}
