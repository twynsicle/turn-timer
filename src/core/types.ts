// Shared data model. Pure types only — imported by the CLI and the report.

export type ToolCategory = "read" | "edit" | "exec" | "agent" | "mcp" | "other";

export type AgentRef =
  | { kind: "main" }
  | { kind: "subagent"; agentId: string; agentType: string; description: string; depth: number };

export interface ToolCall {
  id: string;
  name: string;
  category: ToolCategory;
  /** Short human summary of the input: a path, a pattern, a command line. */
  summary: string;
  /** The input, readable (a shell command as-is, otherwise JSON), capped. */
  input: string;
  /** The result text, capped. Undefined when no result was recorded. */
  result?: string;
  /** Length of the full result text, before capping. */
  resultChars?: number;
  startedAt: number;
  finishedAt?: number;
  isError: boolean;
  denied: boolean;
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
  usage: Usage;
}

/** Token usage of one model response, from the API's `usage` block. */
export interface Usage {
  /** Uncached input tokens. */
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Output tokens, thinking included. */
  output: number;
  webSearches: number;
  /** Served in fast mode (priced higher). */
  fast: boolean;
}

export type PromptKind = "user" | "command" | "notification";

export interface Prompt {
  id: string;
  index: number;
  kind: PromptKind;
  /** The prompt as typed (capped), newlines kept. */
  text: string;
  startedAt: number;
  interrupted: boolean;
  compacted: boolean;
  /** Main-thread turns, in order. Subagent turns hang off ToolCall.subagent. */
  turns: Turn[];
  /** Subagent runs that couldn't be tied to the call that spawned them, filed by start time. */
  detached?: SubagentRun[];
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
  prompts: Prompt[];
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
