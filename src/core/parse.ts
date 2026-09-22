import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { classify, normalizePath } from "./classify.js";
import type { Config } from "./config.js";
import { subagentFiles } from "./discover.js";
import { readLines, tryParse } from "./lines.js";
import { INTERRUPT_PREFIX, blocks, isToolResultRecord, promptTextOf, toolResultText, ts, userText } from "./records.js";
import type { AgentRef, Prompt, Session, SubagentRun, ToolCall, Turn } from "./types.js";

/** Cap on result text kept per call for the dependency heuristic. */
const RESULT_TEXT_CAP = 256 << 10;

interface StreamState {
  agent: AgentRef;
  fileIndex: number;
  turns: Turn[];
  turnsById: Map<string, Turn>;
  /** Turn index (within this stream) of each turn, by message id. */
  turnIndex: Map<string, number>;
  pending: Map<string, { call: ToolCall; turnIdx: number }>;
  /** Recent tool result texts, newest last: normalized text and the turn that produced it. */
  recent: { turnIdx: number; text: string }[];
  lastEventAt: number;
}

interface SessionState {
  cwd: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  prompts: Prompt[];
  current?: Prompt;
  batchingReminders: number;
}

function newStream(agent: AgentRef, fileIndex: number): StreamState {
  return {
    agent,
    fileIndex,
    turns: [],
    turnsById: new Map(),
    turnIndex: new Map(),
    pending: new Map(),
    recent: [],
    lastEventAt: 0,
  };
}

const normText = (s: string) => s.slice(0, RESULT_TEXT_CAP).replace(/\\\\?/g, "/").toLowerCase();

function handleAssistant(rec: any, offset: number, st: StreamState, config: Config): Turn | undefined {
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
      outputTokens: 0,
    };
    st.turnsById.set(id, turn);
    st.turnIndex.set(id, st.turns.length);
    st.turns.push(turn);
  }
  const turnIdx = st.turnIndex.get(id)!;
  if (at > turn.respondedAt) turn.respondedAt = at;
  turn.outputTokens = Math.max(turn.outputTokens, msg.usage?.output_tokens ?? 0);

  for (const b of blocks(rec)) {
    if (b?.type === "text" && b.text?.trim()) turn.hasText = true;
    else if (b?.type === "thinking" || b?.type === "redacted_thinking") turn.hasThinking = true;
    else if (b?.type === "tool_use") {
      const c = classify(b.name, b.input, config);
      const call: ToolCall = {
        id: b.id,
        name: b.name,
        category: c.category,
        readOnly: c.readOnly,
        summary: c.summary,
        paths: c.paths,
        refsBack: findReference(c.needles, turnIdx, st, config.dependencyLookback),
        startedAt: at,
        isError: false,
        denied: false,
        offset,
        file: st.fileIndex,
      };
      turn.toolCalls.push(call);
      st.pending.set(b.id, { call, turnIdx });
    }
  }
  return isNew ? turn : undefined;
}

function findReference(needles: string[], turnIdx: number, st: StreamState, lookback: number): number {
  if (!needles.length) return 0;
  const ns = needles.map((n) => normalizePath(n));
  for (let i = st.recent.length - 1; i >= 0; i--) {
    const r = st.recent[i]!;
    const back = turnIdx - r.turnIdx;
    if (back <= 0) continue;
    if (back > lookback) break;
    if (ns.some((n) => r.text.includes(n))) return back;
  }
  return 0;
}

function handleToolResults(rec: any, offset: number, st: StreamState, lookback: number) {
  const at = ts(rec);
  for (const b of blocks(rec)) {
    if (b?.type !== "tool_result") continue;
    const p = st.pending.get(b.tool_use_id);
    if (!p) continue;
    st.pending.delete(b.tool_use_id);
    p.call.finishedAt = at;
    p.call.resultOffset = offset;
    p.call.isError = b.is_error === true;
    if (rec.toolDenialKind) p.call.denied = true;
    const text = toolResultText(b);
    if (text) {
      st.recent.push({ turnIdx: p.turnIdx, text: normText(text) });
      // Drop results that are out of the lookback window for any future turn.
      const minIdx = st.turns.length - lookback - 1;
      while (st.recent.length && st.recent[0]!.turnIdx < minIdx) st.recent.shift();
    }
  }
  if (at) st.lastEventAt = at;
}

function currentPrompt(ss: SessionState, at: number): Prompt {
  if (!ss.current) {
    ss.current = {
      id: "",
      index: ss.prompts.length,
      kind: "user",
      text: "(no prompt)",
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
  const startsNew = pid ? pid !== ss.current?.id : parsed !== undefined;
  if (startsNew) {
    ss.current = {
      id: pid ?? rec.uuid ?? String(ss.prompts.length),
      index: ss.prompts.length,
      kind: parsed?.kind ?? "user",
      text: parsed?.text ?? "",
      startedAt: at,
      interrupted: false,
      compacted: false,
      turns: [],
    };
    ss.prompts.push(ss.current);
  } else if (ss.current && parsed) {
    if (!ss.current.text) {
      ss.current.text = parsed.text;
      ss.current.kind = parsed.kind;
    } else if (ss.current.kind === "command" && parsed.kind === "user") {
      // e.g. "/model" followed by "continue" under the same promptId
      ss.current.text = `${ss.current.text} → ${parsed.text}`;
    }
  }
  const p = currentPrompt(ss, at);
  if (rec.isCompactSummary) p.compacted = true;
  if (userText(rec).trim().startsWith(INTERRUPT_PREFIX)) p.interrupted = true;
}

async function parseMainFile(path: string, st: StreamState, ss: SessionState, config: Config) {
  for await (const line of readLines(path)) {
    const rec = tryParse(line.text);
    if (!rec || rec.isSidechain) continue;
    const at = ts(rec);
    if (at) {
      if (!ss.startedAt || at < ss.startedAt) ss.startedAt = at;
      if (at > ss.endedAt) ss.endedAt = at;
    }
    if (!ss.cwd && typeof rec.cwd === "string") ss.cwd = rec.cwd;
    switch (rec.type) {
      case "assistant": {
        const turn = handleAssistant(rec, line.offset, st, config);
        if (turn) currentPrompt(ss, at).turns.push(turn);
        break;
      }
      case "user":
        if (isToolResultRecord(rec)) {
          handleToolResults(rec, line.offset, st, config.dependencyLookback);
        } else {
          handleUserText(rec, ss);
          if (at) st.lastEventAt = at;
        }
        break;
      case "system":
        if (rec.subtype === "compact_boundary" && ss.current) ss.current.compacted = true;
        break;
      case "attachment":
        if (rec.attachment?.type === "batching_reminder_sent") ss.batchingReminders++;
        break;
      case "custom-title":
        if (rec.customTitle) ss.title = rec.customTitle;
        break;
    }
  }
}

async function parseSubagentFile(path: string, st: StreamState, config: Config, counters: { reminders: number }) {
  for await (const line of readLines(path)) {
    const rec = tryParse(line.text);
    if (!rec) continue;
    if (rec.type === "assistant") handleAssistant(rec, line.offset, st, config);
    else if (rec.type === "user") {
      if (isToolResultRecord(rec)) handleToolResults(rec, line.offset, st, config.dependencyLookback);
      else if (ts(rec)) st.lastEventAt = ts(rec);
    } else if (rec.type === "attachment" && rec.attachment?.type === "batching_reminder_sent") {
      counters.reminders++;
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

export async function parseSession(path: string, config: Config): Promise<Session> {
  const files = [path];
  const main = newStream({ kind: "main" }, 0);
  const ss: SessionState = { cwd: "", startedAt: 0, endedAt: 0, prompts: [], batchingReminders: 0 };
  await parseMainFile(path, main, ss, config);

  // Subagents: parse each file, then attach to the Agent tool call that spawned it.
  const runsByToolUse = new Map<string, SubagentRun>();
  const counters = { reminders: 0 };
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
    const st = newStream(agent, files.length);
    files.push(f);
    await parseSubagentFile(f, st, config, counters);
    const run: SubagentRun = {
      agentId,
      agentType: agent.agentType,
      description: agent.description,
      depth: agent.depth,
      turns: st.turns,
    };
    if (meta.toolUseId) runsByToolUse.set(meta.toolUseId, run);
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

  return {
    id: basename(path, ".jsonl"),
    projectDir: basename(dirname(path)),
    cwd: ss.cwd,
    title: ss.title,
    startedAt: ss.startedAt,
    endedAt: ss.endedAt,
    files,
    prompts: ss.prompts,
    batchingReminders: ss.batchingReminders + counters.reminders,
  };
}

export function sessionPath(projectsRoot: string, projectDir: string, sessionId: string): string {
  return join(projectsRoot, projectDir, `${sessionId}.jsonl`);
}
