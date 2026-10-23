import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdapter } from "../../src/adapter-factory.js";
import { AcpAgentAdapter, type AcpAdapterOptions } from "../../src/adapters/base.js";
import { CodexAcpAdapter } from "../../src/adapters/codex.js";
import { CustomAcpAdapter } from "../../src/adapters/custom.js";
import { GeminiAcpAdapter } from "../../src/adapters/gemini.js";
import { OpenCodeAcpAdapter } from "../../src/adapters/opencode.js";
import { resetActivityLog } from "../../src/core/activity-log.js";
import { AcpClient } from "../../src/core/client.js";

class TestBaseAdapter extends AcpAgentAdapter {
	get name(): string { return "test-base"; }
}

const constructors = [
	{ name: "base", Adapter: TestBaseAdapter },
	{ name: "codex", Adapter: CodexAcpAdapter },
	{ name: "custom", Adapter: CustomAcpAdapter },
	{ name: "gemini", Adapter: GeminiAcpAdapter },
	{ name: "opencode", Adapter: OpenCodeAcpAdapter },
];

const update: SessionUpdate = {
	sessionUpdate: "tool_call",
	toolCallId: "tool-1",
	title: "read",
	status: "in_progress",
};

async function emitSessionUpdate(adapter: AcpAgentAdapter): Promise<void> {
	await adapter.spawn();
	const client = adapter["client"];
	expect(client).toBeInstanceOf(AcpClient);
	client!["_sessionId"] = "session-1";
	await client!["handleSessionUpdate"]({ sessionId: "session-1", update });
}

describe("adapter callback forwarding through real constructors", () => {
	beforeEach(() => {
		// Keep adapter and client construction real; only prevent process/transport setup.
		vi.spyOn(AcpClient.prototype, "connect").mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetActivityLog();
	});

	it.each(constructors)("$name forwards both callbacks to the client", async ({ Adapter }) => {
		const onActivity = vi.fn();
		const onSessionUpdate = vi.fn();
		const opts: AcpAdapterOptions = {
			config: { command: "test-agent" },
			onActivity,
			onSessionUpdate,
		};
		const adapter = new Adapter(opts);
		try {
			await emitSessionUpdate(adapter);
			expect(onActivity).toHaveBeenCalledExactlyOnceWith("session-1");
			expect(onSessionUpdate).toHaveBeenCalledExactlyOnceWith("session-1", update);
		} finally {
			adapter.dispose();
		}
	});

	it.each(constructors)("$name permits omitted callbacks", async ({ Adapter }) => {
		const adapter = new Adapter({ config: { command: "test-agent" } });
		try {
			await expect(emitSessionUpdate(adapter)).resolves.toBeUndefined();
		} finally {
			adapter.dispose();
		}
	});

	it.each(["codex", "custom", "gemini", "opencode"])(
		"createAdapter preserves callbacks through the real %s adapter",
		async (agentName) => {
			const onActivity = vi.fn();
			const onSessionUpdate = vi.fn();
			const adapter = createAdapter(
				agentName,
				{ command: "test-agent" },
				{ agent_servers: {}, defaultAgent: agentName },
				undefined,
				{ onActivity, onSessionUpdate },
			);
			try {
				await emitSessionUpdate(adapter);
				expect(onActivity).toHaveBeenCalledExactlyOnceWith("session-1");
				expect(onSessionUpdate).toHaveBeenCalledExactlyOnceWith("session-1", update);
			} finally {
				adapter.dispose();
			}
		},
	);
});
