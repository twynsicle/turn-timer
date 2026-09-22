// Shared data model. Pure types only — imported by the CLI, server and web viewer.

export type ToolCategory = "read" | "edit" | "exec" | "agent" | "mcp" | "other";

export type AgentRef =
  | { kind: "main" }
  | { kind: "subagent"; agentId: string; agentType: string; description: string; depth: number };

export interface ToolCall {
  id: string;
  name: string;
  category: ToolCategory;
  /** True when this exec call (Bash/PowerShell) matched the read-only allowlist. */
  readOnly: boolean;
  /** Short human summary of the input: a path, a pattern, a command line. */
  summary: string;
  /** Paths this call reads or writes, normalized for comparison. */
  paths: string[];
  /**
   * How many turns back (1 = previous turn) the nearest tool result that mentions this
   * call's inputs is, within the same agent. 0 = no earlier result (within the lookback
   * window) references it, i.e. the call probably didn't depend on a prior result.
   */
  refsBack: number;
  startedAt: number;
  finishedAt?: number;
  isError: boolean;
  denied: boolean;
  /** Byte offset of the JSONL line holding the tool_use block, in `file`. */
  offset: number;
  /** Byte offset of the JSONL line holding the tool_result, in `file`. */
  resultOffset?: number;
  /** Index into Session.files. */
  file: number;
  subagent?: SubagentRun;
}

export interface Turn {
  messageId: string;
  agent: AgentRef;
  /** Timestamp of the event that triggered this turn (previous tool result or the prompt). */
  requestedAt: number;
  /** Timestamp of the last record of this model response. */
  respondedAt: number;
  model: string;
  toolCalls: ToolCall[];
  hasText: boolean;
  hasThinking: boolean;
  outputTokens: number;
}

export type PromptKind = "user" | "command" | "notification";

export interface Prompt {
  id: string;
  index: number;
  kind: PromptKind;
  text: string;
  startedAt: number;
  interrupted: boolean;
  compacted: boolean;
  /** Main-thread turns, in order. Subagent turns hang off ToolCall.subagent. */
  turns: Turn[];
}

export interface SubagentRun {
  agentId: string;
  agentType: string;
  description: string;
  depth: number;
  turns: Turn[];
}

export interface Session {
  id: string;
  projectDir: string;
  cwd: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  /** Source JSONL files; ToolCall.file indexes into this. Index 0 is the main session file. */
  files: string[];
  prompts: Prompt[];
  /** Times Claude Code itself nudged the model to batch (batching_reminder_sent attachments). */
  batchingReminders: number;
}

export interface ProjectInfo {
  /** Folder name under ~/.claude/projects (the encoded cwd). */
  dir: string;
  /** Real working directory, from the records; falls back to a decoded dir name. */
  cwd: string;
  sessionCount: number;
  lastActive: number;
}

export interface SessionInfo {
  id: string;
  projectDir: string;
  path: string;
  size: number;
  mtime: number;
  cwd?: string;
  title?: string;
  firstPrompt?: string;
  startedAt?: number;
  subagentCount: number;
}
