import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { priceOf } from "../src/core/cost.js";
import { listProjects, listSessions } from "../src/core/discover.js";
import { readLines } from "../src/core/lines.js";
import { analyzeSession, promptActiveMs } from "../src/core/metrics.js";
import { parseSession } from "../src/core/parse.js";
import { sessionRow, trimPreviews } from "../src/core/report-data.js";
import type { Session } from "../src/core/types.js";
import { LogBuilder, writeSession } from "./fixture.js";

describe("readLines", () => {
  it("handles CRLF, multi-byte text, lines larger than the read chunk and a truncated last line", async () => {
    const big = "x".repeat(3 << 20);
    const { path } = writeSession(new LogBuilder().prompt("héllo ✓", "p1").prompt(big, "p2"), [], { crlf: true });
    writeFileSync(path, '{"type":"user","trunc', { flag: "a" });
    const lines = [];
    for await (const l of readLines(path)) lines.push(l);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!.text).message.content).toBe("héllo ✓");
    expect(JSON.parse(lines[1]!.text).message.content).toHaveLength(big.length);
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
    const s = await parseSession(writeSession(log).path);

    expect(s.prompts.map((p) => p.text)).toEqual(["look at the code", "thanks"]);
    const [p1] = s.prompts;
    expect(p1!.turns.map((t) => t.toolCalls.length)).toEqual([3, 1, 0]);
    expect(p1!.turns[0]!.hasText).toBe(true);
    expect(p1!.turns[0]!.toolCalls.map((c) => c.category)).toEqual(["read", "read", "read"]);
    expect(p1!.turns[0]!.toolCalls[0]!.finishedAt).toBeGreaterThan(0);
    expect(analyzeSession(s).prompts[0]).toMatchObject({ turns: 3, toolCalls: 4 });
  });

  it("counts history a resumed session copied into its log once", async () => {
    const log = new LogBuilder().prompt("look at the code", "p1").turn("m1", [["Read", { file_path: "C:\\proj\\a.ts" }]], { promptId: "p1" });
    // The resumed session re-writes those records, uuids unchanged but under a new promptId.
    const copies = log.records.map((r) => ({ ...r, promptId: r.promptId && "p2" }));
    log.records.push(...copies);
    log.prompt("carry on", "p3").turn("m2", [["Read", { file_path: "C:\\proj\\b.ts" }]], { promptId: "p3" });
    const s = await parseSession(writeSession(log).path);

    expect(s.prompts.map((p) => p.text)).toEqual(["look at the code", "carry on"]);
    expect(s.prompts.map((p) => p.turns[0]!.toolCalls.length)).toEqual([1, 1]);
  });

  it("keeps the whole prompt and each call's input, but only the size of its result", async () => {
    const prompt = "Fix the login bug.\n\nSteps:\n1. open the page\n2. " + "detail ".repeat(100);
    const log = new LogBuilder()
      .prompt(prompt, "p1")
      .turn("m1", [["Bash", { command: "npm test", description: "Run tests" }, "3 passed"], ["Read", { file_path: "/a" }, "y".repeat(5000)]], { promptId: "p1" });
    const s = await parseSession(writeSession(log).path);
    expect(s.prompts[0]!.text).toBe(prompt.trim());
    const [bash, read] = s.prompts[0]!.turns[0]!.toolCalls;
    expect(bash).toMatchObject({ summary: "npm test", input: "npm test\n\n# Run tests", resultChars: 8 });
    expect(read!.input).toContain('"file_path": "/a"');
    expect(read!.resultChars).toBe(5000);
    // Tool output never reaches the report.
    expect(JSON.stringify(s)).not.toContain("3 passed");
    expect(JSON.stringify(s)).not.toContain("yyyy");
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
    const s = await parseSession(writeSession(log).path);
    expect(s.prompts).toHaveLength(3);
    expect(s.prompts[0]!.interrupted).toBe(true);
    expect(s.prompts[0]!.compacted).toBe(true);
    expect(s.prompts[1]!.kind).toBe("command");
    expect(s.prompts[1]!.text).toBe("/model → continue");
    expect(s.prompts[2]!.kind).toBe("notification");
  });

  it("reads tool results that share a record with text, without opening a prompt", async () => {
    const log = new LogBuilder()
      .prompt("go", "p1")
      .raw({ type: "assistant", message: { id: "m1", model: "claude-opus-5", role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "sleep 5" } }] } })
      .wait(5000)
      .raw({
        type: "user",
        promptId: "p1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }, { type: "text", text: "[Request interrupted by user for tool use]" }] },
      });
    const s = await parseSession(writeSession(log).path);
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]!.interrupted).toBe(true);
    const call = s.prompts[0]!.turns[0]!.toolCalls[0]!;
    expect(call.resultChars).toBe(4);
    expect(call.finishedAt! - call.startedAt).toBe(6000);
  });

  it("doesn't open an empty prompt when a record reuses an earlier prompt's id", async () => {
    const log = new LogBuilder()
      .prompt("first", "p1")
      .turn("m1", [["Read", { file_path: "/a" }]], { promptId: "p1" })
      .prompt("second", "p2")
      .turn("m2", [["Read", { file_path: "/b" }]], { promptId: "p1" })
      .prompt("[Request interrupted by user]", "p1")
      .prompt("This session is being continued...", "p1", { isCompactSummary: true })
      .prompt("Base directory for this skill: /x", "p3", { isMeta: true })
      .turn("m3", [], { text: "ok" })
      .raw({ type: "user", promptId: "p4", message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "" } }] } });
    const s = await parseSession(writeSession(log).path);
    expect(s.prompts.map((p) => p.text)).toEqual(["first", "second", "[image]"]);
    expect(s.prompts[1]).toMatchObject({ interrupted: true, compacted: true });
    expect(s.prompts[1]!.turns.map((t) => t.messageId)).toEqual(["m2", "m3"]);
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
    );
    const call = s.prompts[0]!.turns[0]!.toolCalls[0]!;
    expect(call.subagent?.turns).toHaveLength(3);
    expect(call.subagent!.turns[0]!.agent).toMatchObject({ kind: "subagent", agentType: "general-purpose" });
    expect(analyzeSession(s).total).toMatchObject({ turns: 4, toolCalls: 3, subagents: 1 });
  });

  it("still counts subagents it can't tie to a call, and old-style inline sidechains", async () => {
    const usage = { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 };
    const main = new LogBuilder()
      .prompt("go", "p1")
      .turn("m1", [["Agent", { description: "x" }]], { promptId: "p1", usage })
      .raw({ type: "assistant", isSidechain: true, message: { id: "side1", model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "hi" }], usage } });
    const orphan = new LogBuilder(true, "zzz").prompt("task", "p1").turn("o1", [], { text: "done", usage });
    const s = await parseSession(writeSession(main, [{ id: "zzz", log: orphan, meta: { agentType: "Explore" } }]).path);
    expect(s.prompts[0]!.detached?.map((r) => r.agentType).sort()).toEqual(["Explore", "sidechain"]);
    // Three turns, each reading $0.50 of cache at Opus 5's rate.
    expect(analyzeSession(s).total.cost.total).toBeCloseTo(1.5, 10);
  });

  it("skips synthetic assistant messages and records denied calls", async () => {
    const log = new LogBuilder()
      .prompt("go", "p1")
      .raw({ type: "assistant", message: { id: "syn", model: "<synthetic>", content: [{ type: "text", text: "API error" }] } })
      .turn("m1", [["Bash", { command: "rm -rf build" }]], { promptId: "p1", denied: true });
    const s = await parseSession(writeSession(log).path);
    expect(s.prompts[0]!.turns).toHaveLength(1);
    expect(s.prompts[0]!.turns[0]!.toolCalls[0]!.denied).toBe(true);
  });
});

describe("time", () => {
  it("counts time once when a subagent keeps running into the next prompt", async () => {
    const main = new LogBuilder()
      .prompt("one", "p1") // t=1s
      .turn("m1", [], { text: "started it", promptId: "p1" }) // t=2s
      .wait(60_000)
      .prompt("two", "p2") // t=63s
      .turn("m2", [], { text: "ok", promptId: "p2" }); // t=64s
    const bg = new LogBuilder(true, "bg").prompt("task", "p1").wait(100_000).turn("b1", [], { text: "done" }); // t=1s … 102s
    const s = await parseSession(writeSession(main, [{ id: "bg", log: bg, meta: { agentType: "general-purpose" } }]).path);
    const a = analyzeSession(s);
    expect(a.prompts.map((p) => p.activeMs)).toEqual([101_000, 1000]);
    expect(a.total.activeMs).toBe(101_000);
  });

  it("measures each prompt from the prompt to its last activity, leaving out idle time between prompts", async () => {
    const log = new LogBuilder()
      .prompt("one", "p1") // t=1s
      .wait(9000)
      .turn("m1", [["Bash", { command: "npm test" }]], { promptId: "p1" }) // response 11s, result 12s
      .wait(3_600_000)
      .prompt("two", "p2")
      .wait(4000)
      .turn("m2", [], { text: "ok", promptId: "p2" });
    const s = await parseSession(writeSession(log).path);
    expect(promptActiveMs(s.prompts[0]!)).toBe(11_000);
    expect(promptActiveMs(s.prompts[1]!)).toBe(5000);
    const st = analyzeSession(s).total;
    expect(st.activeMs).toBe(16_000);
    expect(st.modelMs).toBe(10_000 + 5000);
    expect(st.slowest[0]).toMatchObject({ name: "Bash", ms: 1000, promptIndex: 0 });
    expect(st.byTool.Bash).toMatchObject({ calls: 1, totalMs: 1000 });
  });

  it("doesn't count time spent waiting on your answer as work", async () => {
    const log = new LogBuilder()
      .prompt("one", "p1") // t=1s
      .turn("m1", [["AskUserQuestion", { questions: [] }]], { promptId: "p1", toolMs: 8 * 3_600_000 }) // asked 2s, answered 8h + 3s
      .turn("m2", [["Bash", { command: "npm test" }]], { promptId: "p1" }); // response 8h + 4s, result 8h + 5s
    const s = await parseSession(writeSession(log).path);
    expect(promptActiveMs(s.prompts[0]!)).toBe(3000);
    const st = analyzeSession(s).total;
    expect(st.waitMs).toBe(8 * 3_600_000 + 1000);
    expect(st.activeMs).toBe(3000);
    expect(st.toolMs).toBe(1000);
    expect(st.slowest.map((c) => c.name)).toEqual(["Bash"]);
    expect(st.byTool.AskUserQuestion).toMatchObject({ calls: 1, totalMs: 0 });
  });
});

describe("cache misses", () => {
  // A turn that read `read` tokens from the cache and wrote `write` (5-minute or 1-hour).
  const u = (read: number, write: number, ttl: "5m" | "1h" = "5m") => ({
    input_tokens: 10,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? write : 0, ephemeral_1h_input_tokens: ttl === "1h" ? write : 0 },
    output_tokens: 100,
  });

  it("flags a rebuild after the TTL as expired and prices the rewrite", async () => {
    const log = new LogBuilder()
      .prompt("start", "p1")
      .turn("m1", [], { text: "a", usage: u(0, 100_000) })
      .turn("m2", [], { text: "b", usage: u(100_000, 2000) })
      .wait(6 * 60_000)
      .prompt("back again", "p2")
      .turn("m3", [], { text: "c", usage: u(0, 103_000) });
    const s = await parseSession(writeSession(log).path);
    const a = analyzeSession(s);
    expect(a.total.misses).toHaveLength(1);
    const m = a.total.misses[0]!;
    expect(m).toMatchObject({ kind: "expired", messageId: "m3", promptIndex: 1, ttlMs: 300_000, rebuiltTokens: 102_010 });
    expect(m.gapMs).toBeGreaterThan(300_000);
    // Opus 5: 5-minute writes at 1.25 × $5, reads at $0.50.
    expect(m.cost).toBeCloseTo((102_010 * (6.25 - 0.5)) / 1e6, 10);
    expect(a.prompts[1]!.missCost).toBeCloseTo(m.cost, 10);
    expect(a.total.ttl).toBe("5m");
    expect(sessionRow(s, { id: "sess", projectDir: "C--proj", path: "", size: 1, mtime: 0, subagentCount: 0 }, a)).toMatchObject({
      misses: 1,
      expiries: 1,
      ttl: "5m",
    });
  });

  it("uses the 1-hour TTL once the stream writes 1-hour entries", async () => {
    const log = new LogBuilder()
      .prompt("start", "p1")
      .turn("m1", [], { text: "a", usage: u(0, 100_000, "1h") })
      .wait(20 * 60_000)
      .prompt("back", "p2")
      .turn("m2", [], { text: "b", usage: u(0, 101_000, "1h") });
    const a = analyzeSession(await parseSession(writeSession(log).path));
    expect(a.total.misses[0]).toMatchObject({ kind: "invalidated", ttlMs: 3_600_000 });
    expect(a.total.ttl).toBe("1h");
  });

  it("tells model switches apart, and ignores compaction and normal growth", async () => {
    const log = new LogBuilder()
      .prompt("start", "p1")
      .turn("m1", [], { text: "a", usage: u(0, 200_000) })
      .turn("m2", [], { text: "b", usage: u(200_000, 5000) })
      .prompt("/compact", "p2")
      .turn("m3", [], { text: "summary", usage: u(0, 20_000) })
      .prompt("/model", "p3")
      .turn("m4", [], { text: "c", model: "claude-opus-5-5", usage: u(0, 21_000) });
    const a = analyzeSession(await parseSession(writeSession(log).path));
    expect(a.total.misses.map((m) => [m.messageId, m.kind])).toEqual([["m4", "model-switch"]]);
  });
});

describe("discover", () => {
  it("lists projects and sessions with first prompt and cwd", async () => {
    const { root, path } = writeSession(new LogBuilder().raw({ type: "custom-title", customTitle: "My title" }).prompt("hello world", "p1"));
    const projects = await listProjects(root);
    expect(projects).toEqual([expect.objectContaining({ dir: "C--proj", cwd: "C:\\proj", sessionCount: 1 })]);
    const sessions = await listSessions("C--proj", root);
    expect(sessions[0]).toMatchObject({ id: "sess", firstPrompt: "hello world", title: "My title", path });
  });

  it("skips placeholder prompts and housekeeping commands when picking the first prompt", async () => {
    const cmd = (name: string, args = "") => `<command-name>${name}</command-name>
<command-args>${args}</command-args>`;
    const log = new LogBuilder()
      .turn("m0", [], { text: "resumed" }) // before any prompt: lands in the "(no prompt)" placeholder
      .prompt(cmd("/clear"), "p1")
      .prompt(cmd("/model", "opus"), "p2")
      .prompt(cmd("/deep-review", "the branch"), "p3")
      .prompt("fix the bug", "p4");
    const { root, path } = writeSession(log);
    const s = await parseSession(path);
    const info = { id: "sess", projectDir: "C--proj", path, size: 1, mtime: 0, subagentCount: 0 };
    expect(sessionRow(s, info, analyzeSession(s)).firstPrompt).toBe("/deep-review the branch");
    expect((await listSessions("C--proj", root))[0]!.firstPrompt).toBe("/deep-review the branch");
  });
});

describe("cost", () => {
  const usage = (o: Record<string, unknown>) => ({
    input_tokens: 10,
    cache_creation_input_tokens: 3000,
    cache_read_input_tokens: 100_000,
    output_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    ...o,
  });

  it("counts each response's usage once, though it repeats on every record", async () => {
    const log = new LogBuilder()
      .prompt("go", "p1")
      .turn("m1", [["Read", { file_path: "/a" }], ["Read", { file_path: "/b" }]], { text: "hi", promptId: "p1", usage: usage({}) });
    const s = await parseSession(writeSession(log).path);
    const t = s.prompts[0]!.turns[0]!;
    expect(t.usage).toMatchObject({ input: 10, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 100_000, output: 500 });
    const st = analyzeSession(s).total;
    expect(st.tokens).toEqual({ input: 10, cacheWrite: 3000, cacheRead: 100_000, output: 500 });
    // Opus 5: $5 in, $25 out, $0.50 cache read; writes 1.25× / 2× input.
    const expected = (10 * 5 + 1000 * 5 * 1.25 + 2000 * 5 * 2 + 100_000 * 0.5 + 500 * 25) / 1e6;
    expect(st.cost.total).toBeCloseTo(expected, 10);
    expect(st.peakContext).toBe(103_010);
    expect(st.byModel["claude-opus-5"]).toMatchObject({ turns: 1, priced: true });
  });

  it("prices Opus 5.5 cache reads at 0.05× input", async () => {
    const log = new LogBuilder().prompt("go", "p1").turn("m1", [], { text: "a", model: "claude-opus-5-5", usage: usage({}) });
    const st = analyzeSession(await parseSession(writeSession(log).path)).total;
    expect(st.cost.cacheRead).toBeCloseTo((100_000 * 0.2) / 1e6, 10);
    expect(st.cost.cacheWrite).toBeCloseTo((1000 * 4 * 1.25 + 2000 * 4 * 2) / 1e6, 10);
  });

  it("treats writes without a TTL breakdown as 5-minute, applies fast mode, and skips unknown models", async () => {
    const log = new LogBuilder()
      .prompt("go", "p1")
      .turn("m1", [], { text: "a", usage: usage({ cache_creation: undefined, speed: "fast" }) })
      .turn("m2", [], { text: "b", model: "claude-opus-9", usage: usage({}) });
    const s = await parseSession(writeSession(log).path);
    const [t1] = s.prompts[0]!.turns;
    expect(t1!.usage).toMatchObject({ cacheWrite5m: 3000, cacheWrite1h: 0, fast: true });
    const st = analyzeSession(s).total;
    expect(st.unpricedTurns).toBe(1);
    expect(st.cost.total).toBeCloseTo((2 * (10 * 5 + 3000 * 5 * 1.25 + 100_000 * 0.5 + 500 * 25)) / 1e6, 10);
  });

  it("resolves dated, provider-prefixed and unknown model ids", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toEqual(priceOf("claude-haiku-4-5"));
    expect(priceOf("us.anthropic.claude-opus-4-8-v1:0")).toEqual(priceOf("claude-opus-4-8"));
    expect(priceOf("claude-opus-4-5@20251101")).toEqual(priceOf("claude-opus-4-5"));
    expect(priceOf("claude-opus-5-5[1m]")?.input).toBe(4);
    expect(priceOf("claude-opus-5")?.input).toBe(5);
    expect(priceOf("claude-opus-4-9")).toBeUndefined();
    expect(priceOf("<synthetic>")).toBeUndefined();
  });
});

describe("trimPreviews", () => {
  it("shortens previews when the report has many calls and keeps the count of what was cut", () => {
    const calls = Array.from({ length: 160_000 }, () => ({ category: "shell", input: `${"x".repeat(1000)}\n… 4,000 more characters` }));
    trimPreviews([{ prompts: [{ turns: [{ calls }] }] } as unknown as Session]);
    expect(calls[0]!.input).toBe(`${"x".repeat(300)}\n… 4,700 more characters`);
  });

  it("keeps the count of what was cut when only the note is over the budget", () => {
    // 47,524 calls leave 1,010 characters per preview: the 1,000-character body fits, its note doesn't.
    const input = `${"x".repeat(1000)}\n… 4,000 more characters`;
    const calls = Array.from({ length: 47_524 }, () => ({ category: "shell", input }));
    trimPreviews([{ prompts: [{ turns: [{ calls }] }] } as unknown as Session]);
    expect(calls[0]!.input).toBe(input);
  });
});
