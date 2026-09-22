import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../src/core/classify.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { listProjects, listSessions } from "../src/core/discover.js";
import { readLineAt, readLines } from "../src/core/lines.js";
import { findRuns, promptStats, sessionStats } from "../src/core/metrics.js";
import { parseSession } from "../src/core/parse.js";
import { LogBuilder, writeSession } from "./fixture.js";

const cfg = DEFAULT_CONFIG;

describe("readLines", () => {
  it("tracks byte offsets across LF, CRLF and multi-byte text", async () => {
    const { path } = writeSession(new LogBuilder().prompt("héllo ✓", "p1").prompt("second", "p2"), [], { crlf: true });
    const lines = [];
    for await (const l of readLines(path)) lines.push(l);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(await readLineAt(path, l.offset)).toBe(l.text);
    expect(JSON.parse(lines[0]!.text).message.content).toBe("héllo ✓");
  });

  it("handles lines larger than the read chunk and a truncated last line", async () => {
    const big = "x".repeat(3 << 20);
    const { path } = writeSession(new LogBuilder().prompt(big, "p1"));
    writeFileSync(path, '{"type":"user","trunc', { flag: "a" });
    const lines = [];
    for await (const l of readLines(path)) lines.push(l);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!.text).message.content).toHaveLength(big.length);
    expect(lines[1]!.offset).toBe(lines[0]!.text.length + 1);
  });
});

describe("parseSession", () => {
  it("groups records into prompts and turns by promptId and message id", async () => {
    const log = new LogBuilder()
      .prompt("look at the code", "p1")
      .turn("m1", [["Read", { file_path: "C:\\proj\\a.ts" }], ["Read", { file_path: "C:\\proj\\b.ts" }], ["Grep", { pattern: "foo" }]], { text: "Let me look", promptId: "p1" })
      .turn("m2", [["Edit", { file_path: "C:\\proj\\a.ts" }]], { promptId: "p1" })
      .turn("m3", [], { text: "Done", promptId: "p1" })
      .prompt("thanks", "p2");
    const { path } = writeSession(log);
    const s = await parseSession(path, cfg);

    expect(s.prompts.map((p) => p.text)).toEqual(["look at the code", "thanks"]);
    const [p1] = s.prompts;
    expect(p1!.turns.map((t) => t.toolCalls.length)).toEqual([3, 1, 0]);
    expect(p1!.turns[0]!.hasText).toBe(true);
    expect(p1!.turns[0]!.toolCalls.map((c) => c.category)).toEqual(["read", "read", "read"]);
    expect(p1!.turns[0]!.toolCalls[0]!.finishedAt).toBeGreaterThan(0);

    const st = promptStats(p1!);
    expect(st.toolCalls).toBe(4);
    expect(st.toolTurns).toBe(2);
    expect(st.singleCallTurns).toBe(1);
    expect(st.histogram).toEqual([1, 0, 1, 0, 0, 0]);
  });

  it("keeps meta, compact summaries and interrupts inside the current prompt", async () => {
    const log = new LogBuilder()
      .prompt("do it", "p1")
      .turn("m1", [["Bash", { command: "npm test" }]], { promptId: "p1" })
      .prompt("[Request interrupted by user]", "p1")
      .prompt("This session is being continued...", "p1", { isCompactSummary: true })
      .prompt("<local-command-caveat>Caveat</local-command-caveat>", "p2", { isMeta: true })
      .prompt("<command-name>/model</command-name>\n<command-args></command-args>", "p2")
      .prompt("continue", "p2")
      .prompt("<task-notification>\n<summary>Agent finished</summary></task-notification>", "p3");
    const s = await parseSession((writeSession(log)).path, cfg);
    expect(s.prompts).toHaveLength(3);
    expect(s.prompts[0]!.interrupted).toBe(true);
    expect(s.prompts[0]!.compacted).toBe(true);
    expect(s.prompts[1]!.kind).toBe("command");
    expect(s.prompts[1]!.text).toBe("/model → continue");
    expect(s.prompts[2]!.kind).toBe("notification");
  });

  it("attaches subagent turns to the Agent call that spawned them", async () => {
    const main = new LogBuilder()
      .prompt("review", "p1")
      .turn("m1", [["Agent", { description: "Review code", subagent_type: "general-purpose" }]], { promptId: "p1" });
    const sub = new LogBuilder(true, "abc")
      .prompt("You are a reviewer", "p1")
      .turn("s1", [["Read", { file_path: "/x/one.ts" }]])
      .turn("s2", [["Read", { file_path: "/x/two.ts" }]])
      .turn("s3", [], { text: "Findings" });
    const s = await parseSession(
      writeSession(main, [{ id: "abc", log: sub, meta: { agentType: "general-purpose", description: "Review code", toolUseId: "m1_t0", spawnDepth: 1 } }]).path,
      cfg,
    );
    const call = s.prompts[0]!.turns[0]!.toolCalls[0]!;
    expect(call.subagent?.turns).toHaveLength(3);
    expect(call.subagent!.turns[0]!.agent).toMatchObject({ kind: "subagent", agentType: "general-purpose" });
    expect(s.files).toHaveLength(2);
    expect(call.subagent!.turns[0]!.toolCalls[0]!.file).toBe(1);

    const withSubs = promptStats(s.prompts[0]!);
    const mainOnly = promptStats(s.prompts[0]!, { subagents: false });
    expect(withSubs.toolCalls).toBe(3);
    expect(mainOnly.toolCalls).toBe(1);
    expect(withSubs.runs).toHaveLength(1);
    expect(withSubs.runs[0]!.agent.kind).toBe("subagent");
  });

  it("skips synthetic assistant messages and records denied calls", async () => {
    const log = new LogBuilder()
      .prompt("go", "p1")
      .raw({ type: "assistant", message: { id: "syn", model: "<synthetic>", content: [{ type: "text", text: "API error" }] } })
      .turn("m1", [["Bash", { command: "rm -rf build" }]], { promptId: "p1", denied: true });
    const s = await parseSession(writeSession(log).path, cfg);
    expect(s.prompts[0]!.turns).toHaveLength(1);
    expect(s.prompts[0]!.turns[0]!.toolCalls[0]!.denied).toBe(true);
  });
});

describe("batchable runs", () => {
  it("flags consecutive independent single reads as likely batchable", async () => {
    const log = new LogBuilder()
      .prompt("explore", "p1")
      .turn("m1", [["Read", { file_path: "/p/a.ts" }]], { promptId: "p1" })
      .wait(4000)
      .turn("m2", [["Read", { file_path: "/p/b.ts" }]], { promptId: "p1" })
      .wait(4000)
      .turn("m3", [["Bash", { command: "git status" }]], { promptId: "p1" })
      .turn("m4", [["Bash", { command: "npm run build" }]], { promptId: "p1" });
    const s = await parseSession(writeSession(log).path, cfg);
    const st = sessionStats(s);
    expect(st.runs).toHaveLength(1);
    expect(st.runs[0]).toMatchObject({ kind: "likely", turnIds: ["m1", "m2", "m3"], savedTurns: 2 });
    expect(st.runs[0]!.savedMs).toBeGreaterThanOrEqual(8000);
  });

  it("breaks a run when a call uses a path found in an earlier result", async () => {
    const log = new LogBuilder()
      .prompt("find", "p1")
      .turn("m1", [["Grep", { pattern: "handleLogin" }, "src/auth/login.ts:12: function handleLogin"]], { promptId: "p1" })
      .turn("m2", [["Read", { file_path: "C:\\p\\src\\auth\\login.ts" }]], { promptId: "p1" })
      .turn("m3", [["Read", { file_path: "C:\\p\\src\\other.ts" }]], { promptId: "p1" });
    const s = await parseSession(writeSession(log).path, cfg);
    const turns = s.prompts[0]!.turns;
    expect(turns[1]!.toolCalls[0]!.refsBack).toBe(1);
    expect(turns[2]!.toolCalls[0]!.refsBack).toBe(0);
    // m1 → m2 is dependent; m2 → m3 is independent.
    expect(findRuns(turns, 0).map((r) => r.turnIds)).toEqual([["m2", "m3"]]);
  });

  it("treats edits to different files as possibly batchable, same file as sequential", async () => {
    const log = new LogBuilder()
      .prompt("fix", "p1")
      .turn("m1", [["Edit", { file_path: "/p/a.ts" }]], { promptId: "p1" })
      .turn("m2", [["Edit", { file_path: "/p/b.ts" }]], { promptId: "p1" })
      .turn("m3", [["Edit", { file_path: "/p/b.ts" }]], { promptId: "p1" });
    const s = await parseSession(writeSession(log).path, cfg);
    const runs = findRuns(s.prompts[0]!.turns, 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "possibly", turnIds: ["m1", "m2"] });
  });
});

describe("isReadOnlyCommand", () => {
  const ro = (c: string) => isReadOnlyCommand(c, cfg.readOnlyCommands);
  it.each([
    "git status",
    "git -C /repo log --oneline -5",
    "ls -la && cat package.json",
    "grep -rn foo src | head -20",
    "cd /p && git diff HEAD~1 2>/dev/null",
    "Get-ChildItem -Recurse | Select-Object -First 5",
    "timeout 60 git log -3; sed -n '1,90p' a.shader",
    "wc -l x.cs; sed -n '1,120p' x.cs",
  ])("read-only: %s", (c) => expect(ro(c)).toBe(true));
  it.each(["npm install", "git commit -m x", "echo hi > out.txt", "rm -rf dist", "ls && npm test", "sed -i 's/a/b/' f", "timeout 60 unity cmd recompile", ""])(
    "not read-only: %s",
    (c) => expect(ro(c)).toBe(false),
  );
});

describe("discover", () => {
  it("lists projects and sessions with first prompt and cwd", async () => {
    const { root } = writeSession(new LogBuilder().raw({ type: "custom-title", customTitle: "My title" }).prompt("hello world", "p1"));
    const projects = await listProjects(root);
    expect(projects).toEqual([expect.objectContaining({ dir: "C--proj", cwd: "C:\\proj", sessionCount: 1 })]);
    const sessions = await listSessions("C--proj", root);
    expect(sessions[0]).toMatchObject({ id: "sess", firstPrompt: "hello world", title: "My title" });
    expect(sessions[0]!.path).toBe(join(root, "C--proj", "sess.jsonl"));
  });
});

describe("turnOverheadMs", () => {
  it("subtracts output generation time from model latency", async () => {
    const { turnOverheadMs, MS_PER_OUTPUT_TOKEN } = await import("../src/core/metrics.js");
    const t = { requestedAt: 0, respondedAt: 30_000, outputTokens: 2000 } as Parameters<typeof turnOverheadMs>[0];
    expect(turnOverheadMs(t)).toBe(30_000 - 2000 * MS_PER_OUTPUT_TOKEN);
    expect(turnOverheadMs({ ...t, outputTokens: 10_000 })).toBe(0);
  });
});
