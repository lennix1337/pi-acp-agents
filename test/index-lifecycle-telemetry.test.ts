import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AcpSessionHandle } from "../src/config/types.js";

const telemetry = vi.hoisted(() => ({ contexts: [] as import("../src/hooks/types.js").HookContext[] }));
vi.mock("../src/hooks/config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/hooks/config.js")>();
  return { ...actual, loadHookConfig: () => ({ ...actual.defaultConfig, socket: { ...actual.defaultConfig.socket, enabled: false } }) };
});
vi.mock("../src/hooks/dispatcher.js", () => ({ HookDispatcher: class {
  fire(_event: string, context: import("../src/hooks/types.js").HookContext) { telemetry.contexts.push(context); return Promise.resolve(); }
} }));
vi.mock("../src/hooks/wake-subscriber.js", () => ({ WakeSubscriber: class { start() {} stop() {} } }));
vi.mock("../src/config/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/core/session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../src/management/task-store.js", () => ({ AcpTaskStore: vi.fn() }));
vi.mock("../src/management/mailbox-manager.js", () => ({ MailboxManager: vi.fn() }));
vi.mock("../src/management/governance-store.js", () => ({ GovernanceStore: vi.fn() }));
vi.mock("../src/management/event-log.js", () => ({ AcpEventLog: vi.fn() }));
vi.mock("../src/management/session-archive-store.js", () => ({
	SessionArchiveStore: class MockSessionArchiveStore {
		get = vi.fn((sessionId: string) => sessionArchiveMappings.get(sessionId));
		upsert = vi.fn((session: AcpSessionHandle) => {
			sessionArchiveMappings.set(session.sessionId, session);
			return session;
		});
	},
}));
const sessionArchiveMappings = new Map<string, AcpSessionHandle>();
const sessionNameMappings = new Map<string, string>();
vi.mock("../src/management/session-name-store.js", () => ({
	SessionNameStore: class MockSessionNameStore {
		getSessionId = vi.fn((sessionName: string) => sessionNameMappings.get(sessionName));
		getName = vi.fn((sessionId: string) => Array.from(sessionNameMappings.entries()).find(([, id]) => id === sessionId)?.[0]);
		register = vi.fn((sessionName: string, sessionId: string) => {
			const existing = sessionNameMappings.get(sessionName);
			if (existing && existing !== sessionId) {
				throw new Error(`Session name "${sessionName}" is already assigned to session "${existing}".`);
			}
			sessionNameMappings.set(sessionName, sessionId);
			return { sessionName, sessionId };
		});
		release = vi.fn((sessionId: string) => {
			for (const [k, v] of sessionNameMappings.entries()) if (v === sessionId) sessionNameMappings.delete(k);
		});
	},
}));
vi.mock("../src/management/runtime-paths.js", () => ({
	ensureRuntimeDir: () => ({
		rootDir: "/mock/runtime", tasksFile: "/mock/runtime/tasks.json",
		mailboxesFile: "/mock/runtime/mailboxes.json", governanceFile: "/mock/runtime/governance.json",
		eventLogFile: "/mock/runtime/events.jsonl", sessionArchiveFile: "/mock/runtime/session-archive.json",
		sessionNameRegistryFile: "/mock/runtime/session-name-registry.json", dagDir: "/mock/runtime/dag", dagIndexFile: "/mock/runtime/dag/dag-index.json",
	}),
}));
vi.mock("../src/logger.js", () => ({ createFileLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), createNoopLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../src/core/circuit-breaker.js", () => ({ AcpCircuitBreaker: vi.fn() }));
vi.mock("../src/core/health-monitor.js", () => ({ HealthMonitor: vi.fn() }));
vi.mock("../src/adapter-factory.js", () => ({ createAdapter: vi.fn() }));
vi.mock("../src/coordination/coordinator.js", () => ({ AgentCoordinator: vi.fn() }));
vi.mock("../src/acp-widget.js", () => ({ createAcpWidget: () => () => ({ render: vi.fn() }) }));
vi.mock("../src/dag/dag-store.js", () => ({ DagStore: vi.fn() }));
vi.mock("../src/dag/dag-validator.js", () => ({ DagValidator: vi.fn() }));
vi.mock("../src/dag/dag-executor.js", () => ({ DagExecutor: vi.fn() }));
vi.mock("../src/dag/template-resolver.js", () => ({ TemplateResolver: vi.fn() }));

import main from "../index.js";
import { loadConfig } from "../src/config/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AcpTaskStore } from "../src/management/task-store.js";
import { MailboxManager } from "../src/management/mailbox-manager.js";
import { GovernanceStore } from "../src/management/governance-store.js";
import { AcpEventLog } from "../src/management/event-log.js";
import { AcpCircuitBreaker } from "../src/core/circuit-breaker.js";
import { HealthMonitor } from "../src/core/health-monitor.js";
import { createAdapter } from "../src/adapter-factory.js";
import { AgentCoordinator } from "../src/coordination/coordinator.js";

const CFG = {
	agent_servers: { gemini: { command: "gemini", args: ["--acp"] }, claude: { command: "claude", args: ["--acp"] } },
	defaultAgent: "gemini", staleTimeoutMs: 3_600_000, circuitBreakerMaxFailures: 3, circuitBreakerResetMs: 60_000,
	stallTimeoutMs: 300_000, modelPolicy: {},
};


describe("native prompt lifecycle telemetry wiring", () => {
	let tools: Map<string, any>;
	let m: any;
	let shutdown: (() => Promise<void>) | undefined;
	const ctx = { cwd: "/project", ui: { setWidget: vi.fn(), notify: vi.fn() } };

	beforeEach(() => {
		vi.stubEnv("VITEST", "false");
		telemetry.contexts.length = 0;
		sessionArchiveMappings.clear();
		sessionNameMappings.clear();
		tools = new Map();
		m = {
			sm: { add: vi.fn(), get: vi.fn(), list: vi.fn(() => []), listByAgent: vi.fn(() => []), remove: vi.fn(), disposeAll: vi.fn(), pruneStale: vi.fn(async () => ({ removedSessionIds: [] })), size: 0 },
			ts: { create: vi.fn((i) => ({ id: "t1", subject: i.subject, description: i.description ?? null, status: "pending", assignee: i.assignee ?? null, blockedBy: [], result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
				get: vi.fn(), update: vi.fn((_id, mut) => { const t: any = { id: _id, subject: "mock", status: "pending", blockedBy: [], assignee: null, result: null, createdAt: "", updatedAt: "" }; mut(t); return t; }),
				list: vi.fn(() => []), clear: vi.fn(() => ({ removed: 0, remaining: 0 })) },
			mb: { send: vi.fn((i) => ({ id: "m1", from: i.from, to: i.to, message: i.message, kind: i.kind, createdAt: new Date().toISOString() })),
				listFor: vi.fn(() => []), clearFor: vi.fn(() => 0) },
			gs: { getPlan: vi.fn(), requestPlan: vi.fn((a) => ({ agent: a, status: "pending", requestedAt: new Date().toISOString() })),
				resolvePlan: vi.fn((a, s) => ({ agent: a, status: s, requestedAt: new Date().toISOString(), resolvedAt: new Date().toISOString() })),
				getModelPolicy: vi.fn(() => ({ allowedModels: [], blockedModels: [] })), setModelPolicy: vi.fn(), checkModel: vi.fn(() => ({ ok: true, reason: "" })) },
			el: { append: vi.fn() },
			cb: { execute: vi.fn(async (fn: () => any) => fn()), state: "closed" },
			hm: { start: vi.fn(), stop: vi.fn(), register: vi.fn(), touch: vi.fn(), markPromptStart: vi.fn(), markPromptEnd: vi.fn() },
			ad: { spawn: vi.fn(), initialize: vi.fn(), newSession: vi.fn(async () => "ses-1"), loadSession: vi.fn(async (sessionId?: string) => sessionId ?? "ses-l"),
				prompt: vi.fn(async () => ({ text: "response", stopReason: "end_turn", sessionId: "ses-1" })), setModel: vi.fn(), setMode: vi.fn(), cancel: vi.fn(), dispose: vi.fn() },
			co: { delegate: vi.fn(async () => ({ text: "delegated", stopReason: "end_turn", sessionId: "d1" })),
				broadcast: vi.fn(async () => [{ agent: "gemini", text: "g" }, { agent: "claude", text: "c" }]),
				compare: vi.fn(async () => ({ responses: [{ agent: "gemini", text: "go" }, { agent: "claude", text: "co" }], timestamp: new Date().toISOString() })), dispose: vi.fn() },
		};

		(loadConfig as any).mockReturnValue(CFG);
		(SessionManager as any).mockImplementation(function() { return m.sm; });
		(AcpTaskStore as any).mockImplementation(function() { return m.ts; });
		(MailboxManager as any).mockImplementation(function() { return m.mb; });
		(GovernanceStore as any).mockImplementation(function() { return m.gs; });
		(AcpEventLog as any).mockImplementation(function() { return m.el; });
		(AcpCircuitBreaker as any).mockImplementation(function() { return m.cb; });
		(HealthMonitor as any).mockImplementation(function() { return m.hm; });
		(createAdapter as any).mockImplementation(function() { return m.ad; });
		(AgentCoordinator as any).mockImplementation(function() { return m.co; });

		main({ registerTool: vi.fn((t: any) => tools.set(t.name, t)), registerCommand: vi.fn(), on: vi.fn((event, callback) => { if (event === "session_shutdown") shutdown = callback; }) } as any);
	});

	const exec = (name: string, params: any) => tools.get(name)!.execute("t", params, undefined, undefined, ctx);
  afterEach(async () => { await shutdown?.(); vi.unstubAllEnvs(); });

  const terminal = () => telemetry.contexts.filter(c => c.event === "subagent_stop");
  it.each([false, true])("spawn async=%s publishes accurate success/error/cancel/unknown without a later ambiguous stop", async (asyncSpawn) => {
    for (const stopReason of ["end_turn", "cancelled", "error", "future_reason"]) {
      telemetry.contexts.length = 0;
      m.ad.prompt.mockResolvedValueOnce({ text: "PRIVATE RESPONSE", stopReason, sessionId: "ses-1" });
      await exec("acp_spawn", { agent: "gemini", prompt: "PRIVATE PROMPT", async: asyncSpawn });
      await vi.waitFor(() => expect(terminal()).toHaveLength(1));
      const expected = stopReason === "end_turn" ? "success" : stopReason === "future_reason" ? "unknown" : stopReason;
      expect(terminal()[0].turn).toEqual({ outcome: expected, stopReason });
      expect(terminal()[0].task?.result).toBe(stopReason);
      expect(JSON.stringify(terminal())).not.toContain("PRIVATE");
      if (asyncSpawn) {
        await vi.waitFor(() => expect(telemetry.contexts.some(c => c.event === "spawn_completed")).toBe(true));
        expect(telemetry.contexts.find(c => c.event === "spawn_completed")?.turn).toEqual(terminal()[0].turn);
      }
    }
  });

  it.each([false, true])("spawn async=%s rejects with accurate error/cancel metadata", async (asyncSpawn) => {
    for (const error of [new Error("PRIVATE ERROR"), new DOMException("PRIVATE CANCEL", "AbortError")]) {
      telemetry.contexts.length = 0;
      m.ad.prompt.mockRejectedValueOnce(error);
      await exec("acp_spawn", { agent: "gemini", prompt: "PRIVATE PROMPT", async: asyncSpawn });
      await vi.waitFor(() => expect(terminal()).toHaveLength(1));
      expect(terminal()[0].turn?.outcome).toBe(error.name === "AbortError" ? "cancelled" : "error");
      expect(JSON.stringify(terminal())).not.toContain("PRIVATE");
      if (error.name === "AbortError") expect(telemetry.contexts.some(c => c.event === "session_failed")).toBe(false);
    }
  });


  it.each([false, true])("one-shot async=%s records the prompt outcome before session teardown", async (asyncSpawn) => {
    m.ad.prompt.mockResolvedValueOnce({ text: "PRIVATE RESPONSE", stopReason: "cancelled", sessionId: "ses-1" });
    await exec("acp_spawn", { agent: "gemini", prompt: "PRIVATE PROMPT", async: asyncSpawn, idleTtlMs: 0 });
    await vi.waitFor(() => expect(terminal()).toHaveLength(1));
    expect(terminal()[0].turn).toEqual({ outcome: "cancelled", stopReason: "cancelled" });
    expect(telemetry.contexts.some(c => c.event === "session_failed")).toBe(false);
    expect(telemetry.contexts.some(c => c.event === "spawn_completed")).toBe(false);
  });

  it("wraps live-session messaging and reopened messaging", async () => {
    await exec("acp_spawn", { agent: "gemini", name: "named" });
    const handle = sessionArchiveMappings.get("ses-1")!;
    m.sm.get.mockReturnValue(handle);
    m.ad.prompt.mockResolvedValueOnce({ text: "done", stopReason: "cancelled", sessionId: "ses-1" });
    await exec("acp_msg", { session_id: "ses-1", message: "private" });
    expect(terminal().at(-1)?.turn?.outcome).toBe("cancelled");
    handle.disposed = true;
    m.ad.prompt.mockResolvedValueOnce({ text: "done", stopReason: "max_tokens", sessionId: "ses-1" });
    await exec("acp_msg", { session_id: "ses-1", message: "private" });
    expect(terminal().at(-1)?.turn).toEqual({ outcome: "success", stopReason: "max_tokens" });
  });

  it("routes raw adapter tool notifications through the metadata-only trigger", async () => {
    await exec("acp_spawn", { agent: "gemini" });
    const options = vi.mocked(createAdapter).mock.calls.at(-1)?.[4];
    options?.onSessionUpdate?.("ses-1", { sessionUpdate: "tool_call", toolCallId: "t", title: "PRIVATE TITLE", rawInput: "PRIVATE INPUT", status: "in_progress" });
    const context = telemetry.contexts.find(c => c.event === "tool_call");
    expect(context?.tool).toEqual({ id: "t", status: "in_progress" });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  });
});
