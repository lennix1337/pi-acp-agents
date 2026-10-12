import { beforeEach, describe, expect, it } from "vitest";
import {
	readActivity,
	recordActivity,
	recordTurnEnd,
	renderActivity,
	resetActivityLog,
} from "../../src/core/activity-log.js";

const text = (t: string, kind = "agent_message_chunk") => ({ sessionUpdate: kind, content: { type: "text", text: t } });

describe("activity log", () => {
	beforeEach(resetActivityLog);

	it("polls only what is new since the cursor", () => {
		recordActivity("agy", "s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "run_command: ls", status: "in_progress" });
		const first = readActivity();
		expect(first.events).toHaveLength(1);
		recordActivity("agy", "s1", text("done"));
		const next = readActivity({ since: first.cursor });
		expect(next.events.map((e) => e.kind)).toEqual(["message"]);
		expect(readActivity({ since: next.cursor }).events).toEqual([]);
		expect(readActivity({ since: next.cursor }).cursor).toBe(next.cursor);
	});

	it("filters by agent and session", () => {
		recordActivity("agy", "s1", text("a"));
		recordActivity("opencode", "s2", text("b"));
		expect(readActivity({ agent: "opencode" }).events).toHaveLength(1);
		expect(readActivity({ sessionId: "s1" }).events[0].agent).toBe("agy");
	});

	it("merges chunks and folds tool updates into the call when rendering", () => {
		recordActivity("agy", "sess-0001", { sessionUpdate: "tool_call", toolCallId: "t1", title: "run_command: ls", status: "in_progress" });
		recordActivity("agy", "sess-0001", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
		recordActivity("agy", "sess-0001", text("hel"));
		recordActivity("agy", "sess-0001", text("lo"));
		recordTurnEnd("agy", "sess-0001", "end_turn");
		const out = renderActivity(readActivity().events).split("\n");
		expect(out).toEqual([
			"#1 [agy/sess-000] tool: run_command: ls (completed)",
			"#3 [agy/sess-000] message: hello",
			"#5 [agy/sess-000] turn ended: end_turn",
		]);
	});

	it("ignores malformed updates and keeps a bounded buffer", () => {
		recordActivity("agy", "s", null);
		recordActivity("agy", "s", { sessionUpdate: "agent_message_chunk", content: { type: "image" } });
		expect(readActivity().events).toEqual([]);
		for (let i = 0; i < 1200; i++) recordActivity("agy", "s", text("x"));
		const all = readActivity();
		expect(all.events).toHaveLength(1000);
		expect(all.cursor).toBe(1200);
	});
});
