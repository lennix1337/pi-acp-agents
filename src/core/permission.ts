/**
 * Answer ACP `session/request_permission` calls.
 *
 * ACP requires `{ outcome: { outcome: "selected", optionId } }` (or `cancelled`). The client used
 * to reply `{ outcome: "approved" }`, which is not a valid outcome, so agents that honour the
 * schema treated every request as cancelled. The policy itself is unchanged: approve, preferring
 * a one-time grant over a persistent one.
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export interface PermissionDecision {
	response: RequestPermissionResponse;
	/** What was granted, for the progress log. */
	summary: string;
}

const ALLOW_PREFERENCE = ["allow_once", "allow_always"] as const;

export function decidePermission(req: RequestPermissionRequest): PermissionDecision {
	const title = req.toolCall?.title ?? req.toolCall?.toolCallId ?? "tool call";
	const options = Array.isArray(req.options) ? req.options : [];
	for (const kind of ALLOW_PREFERENCE) {
		const option = options.find((o) => o.kind === kind);
		if (option) {
			return {
				response: { outcome: { outcome: "selected", optionId: option.optionId } },
				summary: `approved "${title}" (${option.kind})`,
			};
		}
	}
	return { response: { outcome: { outcome: "cancelled" } }, summary: `cancelled "${title}" (no allow option offered)` };
}
