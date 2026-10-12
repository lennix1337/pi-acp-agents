import { describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { decidePermission } from "../../src/core/permission.js";

const req = (kinds: string[]): RequestPermissionRequest =>
	({
		sessionId: "s1",
		toolCall: { toolCallId: "t1", title: "ls -la" },
		options: kinds.map((kind, i) => ({ optionId: `o${i}`, name: kind, kind })),
	}) as RequestPermissionRequest;

describe("decidePermission", () => {
	it("selects allow_once over allow_always", () => {
		const d = decidePermission(req(["reject_once", "allow_always", "allow_once"]));
		expect(d.response).toEqual({ outcome: { outcome: "selected", optionId: "o2" } });
	});
	it("falls back to allow_always", () => {
		expect(decidePermission(req(["reject_once", "allow_always"])).response).toEqual({
			outcome: { outcome: "selected", optionId: "o1" },
		});
	});
	it("cancels when no allow option is offered", () => {
		const d = decidePermission(req(["reject_once"]));
		expect(d.response).toEqual({ outcome: { outcome: "cancelled" } });
		expect(d.summary).toContain("cancelled");
	});
	it("tolerates a missing options array", () => {
		expect(decidePermission({ sessionId: "s" } as RequestPermissionRequest).response).toEqual({
			outcome: { outcome: "cancelled" },
		});
	});
});
