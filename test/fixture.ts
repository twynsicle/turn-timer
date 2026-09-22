// Builds synthetic session logs in the real Claude Code JSONL shape.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Rec = Record<string, unknown>;

export class LogBuilder {
  records: Rec[] = [];
  private t = Date.parse("2026-09-01T10:00:00Z");
  private n = 0;
  constructor(private sidechain = false, private agentId?: string) {}

  private base(type: string, extra: Rec = {}): Rec {
    this.t += 1000;
    return {
      type,
      uuid: `u${++this.n}`,
      timestamp: new Date(this.t).toISOString(),
      isSidechain: this.sidechain,
      sessionId: "sess",
      cwd: "C:\\proj",
      ...(this.agentId ? { agentId: this.agentId } : {}),
      ...extra,
    };
  }

  /** Advance the clock (simulates model thinking time). */
  wait(ms: number) {
    this.t += ms;
    return this;
  }

  prompt(text: string, promptId: string, extra: Rec = {}) {
    this.records.push(this.base("user", { promptId, message: { role: "user", content: text }, ...extra }));
    return this;
  }

  /**
   * One model turn. Each block becomes its own record sharing the message id, like the real logs.
   * Tools: [name, input, resultText?]
   */
  turn(id: string, tools: [string, Rec, string?][], opts: { text?: string; promptId?: string; denied?: boolean } = {}) {
    if (opts.text) {
      this.records.push(this.base("assistant", { message: { id, model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: opts.text }] } }));
    }
    tools.forEach(([name, input], i) => {
      this.records.push(
        this.base("assistant", {
          message: { id, model: "claude-opus-5", role: "assistant", content: [{ type: "tool_use", id: `${id}_t${i}`, name, input }] },
        }),
      );
    });
    tools.forEach(([, , result], i) => {
      this.records.push(
        this.base("user", {
          promptId: opts.promptId,
          ...(opts.denied ? { toolDenialKind: "user" } : {}),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${id}_t${i}`, content: result ?? "ok" }] },
          toolUseResult: { stdout: result ?? "ok" },
        }),
      );
    });
    return this;
  }

  raw(rec: Rec) {
    this.records.push(this.base(String(rec.type), rec));
    return this;
  }

  toJsonl(crlf = false) {
    return this.records.map((r) => JSON.stringify(r)).join(crlf ? "\r\n" : "\n") + (crlf ? "\r\n" : "\n");
  }
}

/** Write a project dir with one session (and optional subagents); returns the session path. */
export function writeSession(
  main: LogBuilder,
  subagents: { id: string; log: LogBuilder; meta: Rec }[] = [],
  opts: { crlf?: boolean } = {},
): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "turn-timer-test-"));
  const proj = join(root, "C--proj");
  mkdirSync(proj, { recursive: true });
  const path = join(proj, "sess.jsonl");
  writeFileSync(path, main.toJsonl(opts.crlf));
  if (subagents.length) {
    const dir = join(proj, "sess", "subagents");
    mkdirSync(dir, { recursive: true });
    for (const s of subagents) {
      writeFileSync(join(dir, `agent-${s.id}.jsonl`), s.log.toJsonl());
      writeFileSync(join(dir, `agent-${s.id}.meta.json`), JSON.stringify(s.meta));
    }
  }
  return { root, path };
}
