/**
 * buildHookContext — teams-compat superset JSON (LD1, LD17).
 *
 * correlationId = crypto.randomUUID() (advisory dedup key, LD17).
 * timestamp = new Date().toISOString() (ISO 8601).
 * source is ALWAYS "acp".
 */
import { randomUUID } from "node:crypto";

import type { HookContext, HookEventName, TurnMetadata, ToolMetadata } from "./types.js";

export interface BuildHookContextParams {
	event: HookEventName;
	session: { id: string; agent: string; cwd: string };
	agent: { name: string; type: string };
	task?: {
		id: string;
		subject: string;
		status: string;
		result?: string;
		durationMs?: number;
	};
	turn?: TurnMetadata;
	tool?: ToolMetadata;
	team?: { id: string; leadName: string };
}

/**
 * Build a HookContext. `task`/`team` are only included when provided.
 */
export function buildHookContext(params: BuildHookContextParams): HookContext {
	const ctx: HookContext = {
		version: 1,
		event: params.event,
		source: "acp",
		correlationId: randomUUID(),
		session: params.session,
		agent: params.agent,
		timestamp: new Date().toISOString(),
	};
	if (params.task !== undefined) {
		ctx.task = params.task;
	}
	if (params.turn !== undefined) ctx.turn = params.turn;
	if (params.tool !== undefined) ctx.tool = params.tool;
	if (params.team !== undefined) {
		ctx.team = params.team;
	}
	return ctx;
}
