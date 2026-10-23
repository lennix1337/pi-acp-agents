import type { AcpPromptResult } from "../config/types.js";
import type { SubagentStartLike, SubagentStopLike } from "./trigger-wiring.js";
import type { TurnMetadata } from "./types.js";

export interface PromptHooks {
	onSubagentStart(identity: SubagentStartLike): Promise<void>;
	onSubagentStop(result: SubagentStopLike): Promise<void>;
}

const SUCCESS_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal"]);
const CANCEL_REASONS = new Set(["cancelled", "canceled", "aborted"]);
const ERROR_REASONS = new Set(["error", "failed"]);

/** Protocol completion is not a claim that the agent's task succeeded. */
export function turnFromStopReason(stopReason?: string): TurnMetadata {
	if (typeof stopReason !== "string" || !stopReason) return { outcome: "unknown" };
	const outcome = stopReason && SUCCESS_REASONS.has(stopReason) ? "success"
		: stopReason && CANCEL_REASONS.has(stopReason) ? "cancelled"
		: stopReason && ERROR_REASONS.has(stopReason) ? "error" : "unknown";
	return { outcome, ...(stopReason ? { stopReason } : {}) };
}

export function turnFromError(error: unknown): TurnMetadata {
	return error instanceof Error && error.name === "AbortError"
		? { outcome: "cancelled", stopReason: "cancelled" }
		: { outcome: "error", stopReason: "error" };
}

/** Monitoring is advisory: neither synchronous throws nor rejection may affect a prompt. */
function notify(callback: () => Promise<void>): void {
	try {
		void callback().catch(() => { /* Hook delivery failure must not change the prompt outcome. */ });
	} catch { /* Same isolation for synchronous dispatch failures. */ }
}

/** Wrap the actual timeout/abort boundary, not the underlying RPC which may finish later. */
export async function promptWithTelemetry(
	hooks: PromptHooks | undefined,
	identity: SubagentStartLike,
	prompt: () => Promise<AcpPromptResult>,
): Promise<AcpPromptResult> {
	if (hooks) notify(() => hooks.onSubagentStart(identity));
	let turn: TurnMetadata = { outcome: "unknown" };
	try {
		const result = await prompt();
		turn = turnFromStopReason(result.stopReason);
		return result;
	} catch (error) {
		turn = turnFromError(error);
		throw error;
	} finally {
		if (hooks) notify(() => hooks.onSubagentStop({ ...identity, turn, stopReason: turn.stopReason }));
	}
}
