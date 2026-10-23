import { describe, expect, it, vi } from "vitest";
import { promptWithTelemetry, turnFromStopReason } from "../../src/hooks/prompt-telemetry.js";
import { HookTriggerManager } from "../../src/hooks/trigger-wiring.js";
import { validateHookConfig } from "../../src/hooks/config.js";
import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { DEFAULT_HOOK_CONFIG, type HookContext } from "../../src/hooks/types.js";

const identity = { sessionId: "native-session", agentName: "pi", cwd: "/project" };
function recorder() {
	const contexts: HookContext[] = [];
	const hooks = new HookTriggerManager({ hookDispatcher: { fire: (_event, context) => { contexts.push(context); } } });
	return { hooks, contexts };
}

describe("promptWithTelemetry", () => {
	it.each([
		["end_turn", "success"], ["max_tokens", "success"], ["max_turn_requests", "success"],
		["refusal", "success"], ["cancelled", "cancelled"], ["error", "error"],
		["failed", "error"], ["future_reason", "unknown"], [undefined, "unknown"],
	])("classifies %s without inferring task success", (reason, outcome) => {
		expect(turnFromStopReason(reason)).toMatchObject({ outcome });
	});

	it.each([false, true])("records exactly one explicit terminal outcome (delayed=%s)", async (delayed) => {
		for (const stopReason of ["end_turn", "error", "cancelled", "future_reason"]) {
			const { hooks, contexts } = recorder();
			const result = { text: "PRIVATE RESPONSE", sessionId: identity.sessionId, stopReason };
			const actual = await promptWithTelemetry(hooks, identity, async () => {
				if (delayed) await new Promise(resolve => setImmediate(resolve));
				return result;
			});
			expect(actual).toBe(result);
			expect(contexts.map(c => c.event)).toEqual(["subagent_start", "subagent_stop"]);
			expect(contexts[1].turn).toEqual(turnFromStopReason(stopReason));
			expect(contexts[1].task?.result).toBe(stopReason);
			expect(JSON.stringify(contexts)).not.toContain("PRIVATE");
		}
	});

	it.each([new Error("PRIVATE FAILURE"), new DOMException("PRIVATE CANCEL", "AbortError")])("preserves rejection and excludes exception content", async (error) => {
		const { hooks, contexts } = recorder();
		await expect(promptWithTelemetry(hooks, identity, () => Promise.reject(error))).rejects.toBe(error);
		expect(contexts[1].turn?.outcome).toBe(error.name === "AbortError" ? "cancelled" : "error");
		expect(JSON.stringify(contexts)).not.toContain("PRIVATE");
	});

	it("does not emit a later success after a timed-out RPC resolves", async () => {
		const { hooks, contexts } = recorder();
		let resolve!: (value: { text: string; sessionId: string; stopReason: string }) => void;
		const rpc = new Promise<{ text: string; sessionId: string; stopReason: string }>(r => { resolve = r; });
		await expect(promptWithTelemetry(hooks, identity, () => Promise.race([rpc, Promise.reject(new Error("timeout"))]))).rejects.toThrow("timeout");
		resolve({ text: "late", sessionId: identity.sessionId, stopReason: "end_turn" });
		await rpc;
		expect(contexts.map(c => c.turn?.outcome)).toEqual([undefined, "error"]);
	});

	it.each([true, false])("isolates synchronous and asynchronous hook delivery failure (%s)", async (synchronous) => {
		const fail = () => { if (synchronous) throw new Error("monitor down"); return Promise.reject(new Error("monitor down")); };
		const result = { text: "ok", sessionId: "s", stopReason: "end_turn" };
		await expect(promptWithTelemetry({ onSubagentStart: fail, onSubagentStop: fail }, identity, async () => result)).resolves.toBe(result);
		const hooks = new HookTriggerManager({ hookDispatcher: { fire: fail } });
		await expect(hooks.onSubagentStop({ ...identity, stopReason: "error" })).resolves.toBeUndefined();
	});
});

describe("metadata-only tool hooks", () => {
	it("accepts per-event enablement for tool and async completion hooks", () => {
		const hooks = { tool_call: { enabled: false, timeoutMs: 1000 }, tool_call_update: { enabled: true, timeoutMs: 2000 }, spawn_completed: { enabled: true, timeoutMs: 3000 } };
		expect(validateHookConfig({ hooks }).hooks).toEqual(hooks);
	});

	it.each(["tool_call", "tool_call_update"] as const)("whitelists %s metadata without content or task policy", async (sessionUpdate) => {
		const { hooks, contexts } = recorder();
		await hooks.onToolActivity(identity, {
			sessionUpdate, toolCallId: "tool-1", name: "bash", status: "completed", title: "PRIVATE TITLE",
			rawInput: { token: "PRIVATE INPUT" }, rawOutput: "PRIVATE OUTPUT",
			content: [{ type: "text", text: "PRIVATE CONTENT" }], _meta: { secret: "PRIVATE META" },
		} as never);
		expect(contexts[0].tool).toEqual({ id: "tool-1", name: "bash", status: "completed" });
		expect(contexts[0].session).toEqual({ id: identity.sessionId, agent: "pi", cwd: "/project" });
		expect(contexts[0]).not.toHaveProperty("task");
		expect(JSON.stringify(contexts)).not.toContain("PRIVATE");
		const policy = vi.fn();
		const dispatcher = new HookDispatcher({ config: DEFAULT_HOOK_CONFIG, hooksDir: "/nonexistent", applyFailurePolicy: policy });
		dispatcher.on({ phase: "post", event: sessionUpdate, handler: () => { throw new Error("monitor down"); } });
		await dispatcher.fire(sessionUpdate, contexts[0]);
		expect(policy).not.toHaveBeenCalled();
	});

	it("never treats title or arbitrary _meta as a tool name and ignores conversation updates", async () => {
		const { hooks, contexts } = recorder();
		await hooks.onToolActivity(identity, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "bash secret", _meta: { name: "bash secret" } });
		await hooks.onToolActivity(identity, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PRIVATE" } });
		expect(contexts).toHaveLength(1);
		expect(contexts[0].tool).toEqual({ id: "tool-1" });
	});
});
