import { describe, expect, it } from "vitest";
import { runHarnessTask, type HarnessTaskClient } from "../../src/core/harness-task.js";

function fakeClient(over: Partial<HarnessTaskClient> = {}, calls: string[] = []): HarnessTaskClient {
	return {
		connect: async () => void calls.push("connect"),
		initialize: async () => void calls.push("initialize"),
		newSession: async () => (calls.push("newSession"), "s1"),
		prompt: async (m) => (calls.push(`prompt:${m}`), { text: "ok", stopReason: "end_turn" }),
		dispose: async () => void calls.push("dispose"),
		...over,
	};
}

describe("runHarnessTask", () => {
	it("runs the handshake, one prompt and disposes, returning the text", async () => {
		const calls: string[] = [];
		const r = await runHarnessTask({ prompt: "oi", timeoutMs: 1000, createClient: () => fakeClient({}, calls) });
		expect(calls).toEqual(["connect", "initialize", "newSession", "prompt:oi", "dispose"]);
		expect(r).toEqual({ ok: true, text: "ok", stopReason: "end_turn", updates: 0 });
	});

	it("counts progress updates without exposing their content", async () => {
		const r = await runHarnessTask({
			prompt: "x",
			timeoutMs: 1000,
			createClient: (onProgress) =>
				fakeClient({
					prompt: async () => {
						onProgress({ type: "update", updateType: "agent_message_chunk" });
						onProgress({ type: "update", updateType: "tool_call" });
						return { text: "t", stopReason: "end_turn" };
					},
				}),
		});
		expect(r.ok && r.updates).toBe(2);
	});

	it("reports a failure (never throws) and still disposes", async () => {
		const calls: string[] = [];
		const r = await runHarnessTask({
			prompt: "x",
			timeoutMs: 1000,
			createClient: () => fakeClient({ newSession: async () => { throw new Error("auth required"); } }, calls),
		});
		expect(r).toEqual({ ok: false, error: "auth required", phase: "newSession" });
		expect(calls.at(-1)).toBe("dispose");
	});

	it("times out a hung prompt, disposes and says so", async () => {
		const calls: string[] = [];
		const r = await runHarnessTask({
			prompt: "x",
			timeoutMs: 30,
			createClient: () => fakeClient({ prompt: () => new Promise(() => {}) }, calls),
		});
		expect(r).toEqual({ ok: false, error: "timeout after 30 ms", phase: "prompt" });
		expect(calls.at(-1)).toBe("dispose");
	});
});
