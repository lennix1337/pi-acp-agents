import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { buildHookContext } from "../../src/hooks/hook-context.js";
import { promptWithTelemetry } from "../../src/hooks/prompt-telemetry.js";
import { HookTriggerManager } from "../../src/hooks/trigger-wiring.js";
import { DEFAULT_HOOK_CONFIG, type HookEventName } from "../../src/hooks/types.js";

const identity = { sessionId: "native-session", agentName: "pi", cwd: "/project" };
const config = { ...DEFAULT_HOOK_CONFIG, socket: { ...DEFAULT_HOOK_CONFIG.socket, enabled: false } };

function context(event: HookEventName, sessionId = identity.sessionId) {
	return buildHookContext({ event, session: { id: sessionId, agent: "pi", cwd: "/project" }, agent: { name: "pi", type: "acp" } });
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { promise, release };
}

describe("HookDispatcher native session ordering", () => {
	let dir: string;
	beforeEach(() => {
		mkdirSync("scratchpad", { recursive: true });
		dir = mkdtempSync(join("scratchpad", "hook-ordering-"));
	});
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it.each(["subagent_start", "tool_call"])("waits for a deliberately delayed %s subprocess before terminal delivery without blocking the prompt", async delayedEvent => {
		const marker = join(dir, "entered");
		const release = join(dir, "release");
		const log = join(dir, "delivery.log");
		writeFileSync(join(dir, "monitor.mjs"), `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const event = process.env.ACP_HOOK_EVENT;
if (event === ${JSON.stringify(delayedEvent)}) {
  writeFileSync(${JSON.stringify(marker)}, "entered");
  while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
}
appendFileSync(${JSON.stringify(log)}, event + "\\n");
`);
		const dispatcher = new HookDispatcher({ config, hooksDir: dir });
		const hooks = new HookTriggerManager({ hookDispatcher: dispatcher });
		const toolDeliveries: Promise<void>[] = [];
		const result = { text: "ok", sessionId: identity.sessionId, stopReason: "end_turn" };
		// The prompt settles while the real hook process remains gated.
		await expect(promptWithTelemetry(hooks, identity, async () => {
			toolDeliveries.push(hooks.onToolActivity(identity, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Tool", status: "pending" }));
			toolDeliveries.push(hooks.onToolActivity(identity, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" }));
			return result;
		})).resolves.toBe(result);
		const spawnDone = hooks.onSpawnCompleted({ ...identity, stopReason: "end_turn" });
		const sessionDone = hooks.onSessionRemoved({ id: identity.sessionId, agent: "pi", cwd: identity.cwd });
		try {
			await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
			const delivered = existsSync(log) ? readFileSync(log, "utf8") : "";
			expect(delivered).not.toContain("subagent_stop");
			expect(delivered).not.toContain("spawn_completed");
			expect(delivered).not.toContain("session_completed");
		} finally {
			writeFileSync(release, "release");
			await Promise.all([...toolDeliveries, spawnDone, sessionDone]);
		}
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
			"subagent_start", "tool_call", "tool_call_update", "subagent_stop", "spawn_completed", "session_completed",
		]);
	});

	it.each([new Error("timeout"), new DOMException("cancelled", "AbortError")])("retains the prompt rejection while delayed tool delivery precedes its terminal outcome (%s)", async error => {
		const blocked = gate();
		const outcomes: Array<string | undefined> = [];
		const dispatcher = new HookDispatcher({ config, hooksDir: dir });
		const hooks = new HookTriggerManager({ hookDispatcher: dispatcher });
		dispatcher.registerPostHook("tool_call", () => blocked.promise);
		dispatcher.registerPostHook("subagent_stop", ctx => { outcomes.push(ctx.turn?.outcome); });
		let toolDelivery!: Promise<void>;
		await expect(promptWithTelemetry(hooks, identity, async () => {
			toolDelivery = hooks.onToolActivity(identity, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Tool" });
			throw error;
		})).rejects.toBe(error);
		const terminal = hooks.onSessionRemoved({ id: identity.sessionId, agent: "pi", cwd: identity.cwd }, { error: true });
		try {
			await new Promise(resolve => setImmediate(resolve));
			expect(outcomes).toEqual([]);
		} finally { blocked.release(); await Promise.all([toolDelivery, terminal]); }
		expect(outcomes).toEqual([error.name === "AbortError" ? "cancelled" : "error"]);
	});

	it("orders the complete pipeline, including delayed pre-hooks, socket publication and failure policy", async () => {
		const pre = gate();
		const publish = gate();
		const policy = gate();
		const order: string[] = [];
		const dispatcher = new HookDispatcher({
			config: { ...config, socket: { ...config.socket, enabled: true } }, hooksDir: dir,
			publisher: { publish: async event => {
				if (event.payload.event === "subagent_start") await publish.promise;
				order.push(event.payload.event);
				return true;
			} },
			applyFailurePolicy: async action => { await policy.promise; order.push("policy"); return { handled: true, action }; },
		});
		writeFileSync(join(dir, "fail.mjs"), "process.exit(process.env.ACP_HOOK_EVENT === 'subagent_stop' ? 1 : 0);");
		dispatcher.registerPreHook("subagent_start", () => pre.promise);
		const start = dispatcher.fire("subagent_start", context("subagent_start"));
		const stop = dispatcher.fire("subagent_stop", { ...context("subagent_stop"), task: { id: "t", subject: "turn", status: "completed" } });
		const done = dispatcher.fire("session_completed", context("session_completed"));
		try {
			await new Promise(resolve => setImmediate(resolve));
			expect(order).toEqual([]);
			pre.release();
			await new Promise(resolve => setImmediate(resolve));
			expect(order).toEqual([]);
			publish.release();
			await start;
			await vi.waitFor(() => expect(order).toContain("subagent_stop"));
			expect(order).not.toContain("session_completed");
		} finally {
			pre.release(); publish.release(); policy.release();
			await Promise.all([start, stop, done]);
		}
		expect(order).toEqual(["subagent_start", "subagent_stop", "policy", "session_completed"]);
		expect((await stop).policyApplied).toBe(true);
	});

	it("keeps other sessions, unkeyed telemetry and task/policy hooks independent", async () => {
		const blocked = gate();
		const dispatcher = new HookDispatcher({ config, hooksDir: dir });
		dispatcher.registerPostHook("subagent_start", ctx => ctx.session.id === identity.sessionId ? blocked.promise : undefined);
		const slow = dispatcher.fire("subagent_start", context("subagent_start"));
		try {
			const independent = [
				dispatcher.fire("subagent_stop", context("subagent_stop", "other-session")),
				dispatcher.fire("subagent_start", context("subagent_start", "")),
				dispatcher.fire("task_completed", context("task_completed")),
			];
			for (const result of await Promise.all(independent)) expect(result.skipped).toBe(false);
		} finally { blocked.release(); await slow; }
	});

	it("caps outstanding tool metadata at 128 without dropping lifecycle terminals or leaking guard keys", async () => {
		const blocked = gate();
		const delivered: HookEventName[] = [];
		const dispatcher = new HookDispatcher({ config, hooksDir: dir, enableReentrancyGuard: true });
		dispatcher.registerPreHook("subagent_start", () => blocked.promise);
		for (const event of ["tool_call", "tool_call_update", "subagent_stop", "session_failed", "spawn_completed"] as const) {
			dispatcher.registerPostHook(event, () => { delivered.push(event); });
		}
		const start = dispatcher.fire("subagent_start", context("subagent_start"));
		const tools = Array.from({ length: 128 }, (_, i) => {
			const event = i % 2 ? "tool_call_update" : "tool_call";
			return dispatcher.fire(event, context(event));
		});
		const overflow = dispatcher.fire("tool_call_update", context("tool_call_update"));
		const terminals = ["subagent_stop", "session_failed", "spawn_completed"] as const;
		const terminalDelivery = terminals.map(event => dispatcher.fire(event, context(event)));
		try {
			expect(await overflow).toMatchObject({ skipped: true, skippedReason: "session-tool-queue-full", policyApplied: false });
			expect(delivered).toEqual([]);
		} finally { blocked.release(); await Promise.all([start, ...tools, ...terminalDelivery]); }
		expect(delivered.slice(-3)).toEqual(terminals);
		expect(delivered).toHaveLength(131);
		expect(dispatcher.getInFlightKeys()).toEqual([]);
		expect((await dispatcher.fire("tool_call", context("tool_call"))).skipped).toBe(false);
	});

	it("continues after suppressed hooks and isolated delivery failures", async () => {
		const calls: string[] = [];
		const dispatcher = new HookDispatcher({ config, hooksDir: dir });
		dispatcher.registerPreHook("subagent_start", () => ({ blockAll: true }));
		dispatcher.registerPostHook("tool_call", () => { throw new Error("monitor down"); });
		dispatcher.registerPostHook("subagent_stop", () => { calls.push("stop"); });
		const results = await Promise.all(["subagent_start", "tool_call", "subagent_stop"].map(event => dispatcher.fire(event as HookEventName, context(event as HookEventName))));
		expect(results[0].blocked).toBe(true);
		expect(calls).toEqual(["stop"]);
	});
});
