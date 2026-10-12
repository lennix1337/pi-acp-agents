/**
 * In-memory activity log fed by ACP `session/update` notifications.
 *
 * It gives an LLM a cheap, local poll surface: ask "what happened since cursor N"
 * and get tool calls, message text and turn ends, without any network request or
 * extra agent turn. Consecutive text chunks stay separate events (so a reader's
 * cursor never misses late-appended text) and are merged only when rendered.
 */
export type ActivityKind = "tool" | "message" | "thought" | "turn";

export interface ActivityEvent {
	seq: number;
	at: number;
	agent: string;
	sessionId: string;
	kind: ActivityKind;
	text: string;
	/** Tool call id, for `tool` events. */
	toolId?: string;
	/** Tool status (`pending|in_progress|completed|failed`) or turn stop reason. */
	status?: string;
}

const CAPACITY = 1000;
let events: ActivityEvent[] = [];
let nextSeq = 1;

function push(e: Omit<ActivityEvent, "seq" | "at">): void {
	events.push({ ...e, seq: nextSeq++, at: Date.now() });
	if (events.length > CAPACITY) events = events.slice(events.length - CAPACITY);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Record one raw ACP session update; unknown or malformed updates are ignored. */
export function recordActivity(agent: string, sessionId: string, update: unknown): void {
	if (!update || typeof update !== "object") return;
	const u = update as Record<string, unknown>;
	switch (u.sessionUpdate) {
		case "tool_call":
		case "tool_call_update":
			push({
				agent,
				sessionId,
				kind: "tool",
				toolId: str(u.toolCallId),
				status: str(u.status),
				text: str(u.title) ?? "",
			});
			return;
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const content = u.content as { type?: string; text?: string } | undefined;
			if (content?.type !== "text" || !content.text) return;
			push({
				agent,
				sessionId,
				kind: u.sessionUpdate === "agent_message_chunk" ? "message" : "thought",
				text: content.text,
			});
			return;
		}
	}
}

export function recordTurnEnd(agent: string, sessionId: string, stopReason: string): void {
	push({ agent, sessionId, kind: "turn", status: stopReason, text: "" });
}

export interface ActivityQuery {
	since?: number;
	agent?: string;
	sessionId?: string;
	limit?: number;
}

/** Events after `since` (exclusive), oldest first, plus the cursor to poll with next. */
export function readActivity(q: ActivityQuery = {}): { events: ActivityEvent[]; cursor: number } {
	const since = q.since ?? 0;
	let out = events.filter(
		(e) => e.seq > since && (!q.agent || e.agent === q.agent) && (!q.sessionId || e.sessionId === q.sessionId),
	);
	if (q.limit && out.length > q.limit) out = out.slice(0, q.limit);
	return { events: out, cursor: out.length ? out[out.length - 1].seq : since };
}

/** Human/LLM-readable rendering: text chunks merged, tool updates folded into their call. */
export function renderActivity(list: ActivityEvent[]): string {
	const lines: string[] = [];
	let open: { key: string; idx: number } | undefined;
	const toolLine = new Map<string, number>();
	for (const e of list) {
		const tag = `[${e.agent}/${e.sessionId.slice(0, 8)}]`;
		if (e.kind === "message" || e.kind === "thought") {
			const key = `${e.kind}:${e.agent}:${e.sessionId}`;
			if (open?.key === key) {
				lines[open.idx] += e.text.replace(/\n+/g, " ");
			} else {
				open = { key, idx: lines.length };
				lines.push(`#${e.seq} ${tag} ${e.kind}: ${e.text.replace(/\n+/g, " ")}`);
			}
			continue;
		}
		open = undefined;
		if (e.kind === "turn") {
			lines.push(`#${e.seq} ${tag} turn ended: ${e.status}`);
			continue;
		}
		const tk = `${e.sessionId}:${e.toolId ?? e.seq}`;
		const prev = toolLine.get(tk);
		if (prev !== undefined) {
			lines[prev] = lines[prev].replace(/ \((\w+)\)$/, "") + ` (${e.status ?? "update"})`;
		} else {
			toolLine.set(tk, lines.length);
			lines.push(`#${e.seq} ${tag} tool: ${e.text} (${e.status ?? "pending"})`);
		}
	}
	return lines.join("\n");
}

export function resetActivityLog(): void {
	events = [];
	nextSeq = 1;
}
