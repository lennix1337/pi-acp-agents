import { describe, it, expect, vi } from "vitest";
import { AgentCoordinator } from "../../src/coordination/coordinator.js";
import { createAdapter } from "../../src/adapter-factory.js";
import { HookTriggerManager } from "../../src/hooks/trigger-wiring.js";
import type { HookContext } from "../../src/hooks/types.js";

vi.mock("../../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));

function setup() {
	const contexts: HookContext[] = [];
	const hookTriggers = new HookTriggerManager({ hookDispatcher: { fire: (_event, context) => { contexts.push(context); } } });
	const adapter = {
		spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "native-id"),
		getSessionId: () => "native-id", connected: true, cancel: vi.fn(), dispose: vi.fn(),
		prompt: vi.fn(async () => ({ text: "PRIVATE RESULT", sessionId: "native-id", stopReason: "end_turn" })),
	};
	vi.mocked(createAdapter).mockReturnValue(adapter as never);
	const coordinator = new AgentCoordinator({ agent_servers: { pi: { command: "pi-acp" } }, defaultAgent: "pi" }, "/project", { hookTriggers });
	return { contexts, adapter, coordinator };
}

describe("coordinator native telemetry", () => {
	it("uses the native session ID for repeated pooled turns and tool metadata", async () => {
		const { coordinator, contexts } = setup();
		try {
			await coordinator.delegate("pi", "PRIVATE PROMPT");
			await coordinator.delegate("pi", "PRIVATE FOLLOWUP");
			const opts = vi.mocked(createAdapter).mock.calls.at(-1)?.[4];
			opts?.onSessionUpdate?.("native-id", { sessionUpdate: "tool_call_update", toolCallId: "tool-id", status: "failed", title: "PRIVATE TITLE", rawOutput: "PRIVATE OUTPUT" });
			expect(contexts.map(c => c.event)).toEqual(["session_started", "subagent_start", "subagent_stop", "subagent_start", "subagent_stop", "tool_call_update"]);
			expect(contexts.every(c => c.session.id === "native-id" && c.session.cwd === "/project")).toBe(true);
			expect(contexts.at(-1)?.tool).toEqual({ id: "tool-id", status: "failed" });
			expect(JSON.stringify(contexts)).not.toContain("PRIVATE");
		} finally { coordinator.dispose(); }
	});

	it("records a rejected prompt as error without a success terminal event", async () => {
		const { coordinator, adapter, contexts } = setup();
		adapter.prompt.mockRejectedValueOnce(new Error("PRIVATE ERROR"));
		await expect(coordinator.delegate("pi", "private")).rejects.toThrow("PRIVATE ERROR");
		expect(contexts.filter(c => c.event === "subagent_stop").map(c => c.turn)).toEqual([{ outcome: "error", stopReason: "error" }]);
		expect(JSON.stringify(contexts)).not.toContain("PRIVATE");
		coordinator.dispose();
	});

	it("records abort at the orchestration race boundary, ignoring late RPC success", async () => {
		const { coordinator, adapter, contexts } = setup();
		let resolve!: (result: { text: string; sessionId: string; stopReason: string }) => void;
		adapter.prompt.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
		const controller = new AbortController();
		const pending = coordinator.delegate("pi", "private", undefined, undefined, controller.signal);
		await vi.waitFor(() => expect(adapter.prompt).toHaveBeenCalled());
		controller.abort();
		await expect(pending).rejects.toThrow();
		resolve({ text: "PRIVATE LATE", sessionId: "native-id", stopReason: "end_turn" });
		await Promise.resolve();
		expect(contexts.filter(c => c.event === "subagent_stop").map(c => c.turn)).toEqual([{ outcome: "cancelled", stopReason: "cancelled" }]);
		coordinator.dispose();
	});
});
