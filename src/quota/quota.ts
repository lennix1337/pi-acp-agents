/**
 * Remaining-quota reporting for ACP agents.
 *
 * ACP has no quota method, so each agent profile may declare a
 * `quota_command` (argv array, no shell) that prints one JSON object:
 *   { "remaining": number, "limit"?: number, "unit"?: string,
 *     "resetsAt"?: string, "detail"?: string }
 * Agents without a source report that plainly instead of guessing.
 */
import { execFile } from "node:child_process";

import type { AcpAgentConfig } from "../config/types.js";
import { usageFor } from "../core/usage-ledger.js";

export interface QuotaReading {
	remaining: number;
	limit?: number;
	unit?: string;
	resetsAt?: string;
	detail?: string;
}

export type QuotaResult =
	| { agent: string; status: "ok"; reading: QuotaReading }
	| { agent: string; status: "unavailable"; reason: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/** Parse and validate a quota command's stdout. Throws on a malformed reading. */
export function parseQuotaOutput(stdout: string): QuotaReading {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		throw new Error("quota command did not print JSON");
	}
	if (typeof raw !== "object" || raw === null) throw new Error("quota JSON must be an object");
	const o = raw as Record<string, unknown>;
	if (typeof o.remaining !== "number" || !Number.isFinite(o.remaining) || o.remaining < 0) {
		throw new Error("quota JSON needs a non-negative numeric 'remaining'");
	}
	const reading: QuotaReading = { remaining: o.remaining };
	if (typeof o.limit === "number" && Number.isFinite(o.limit)) reading.limit = o.limit;
	for (const key of ["unit", "resetsAt", "detail"] as const) {
		if (typeof o[key] === "string") reading[key] = o[key] as string;
	}
	return reading;
}

function runCommand(argv: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const [file, ...args] = argv;
		execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
			if (err) {
				const detail = stderr.trim().split("\n").pop() ?? "";
				reject(new Error(`${err.message.split("\n")[0]}${detail ? ` (${detail})` : ""}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/** Read one agent's remaining quota; never throws. */
export async function readQuota(
	agent: string,
	cfg: AcpAgentConfig,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<QuotaResult> {
	const argv = cfg.quota_command;
	if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
		return { agent, status: "unavailable", reason: "no quota_command configured (the backend exposes no quota)" };
	}
	try {
		const reading = parseQuotaOutput(await runCommand(argv as string[], timeoutMs));
		return { agent, status: "ok", reading };
	} catch (err) {
		return { agent, status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
	}
}

export function renderQuota(results: QuotaResult[]): string {
	return results
		.map((r) => {
			if (r.status === "unavailable") return `${r.agent}: unavailable — ${r.reason}`;
			const { remaining, limit, unit, resetsAt, detail } = r.reading;
			const of = limit === undefined ? "" : ` of ${limit}`;
			return `${r.agent}: ${remaining}${of} ${unit ?? "units"} left${resetsAt ? `, resets ${resetsAt}` : ""}${detail ? ` — ${detail}` : ""}`;
		})
		.join("\n");
}

/** Quota readings for the named agents plus tokens used this session, as one report. */
export async function buildQuotaReport(
	servers: Record<string, AcpAgentConfig>,
	only?: string,
): Promise<{ text: string; results: QuotaResult[] }> {
	const names = only ? [only] : Object.keys(servers);
	const results = await Promise.all(
		names.map((name) =>
			servers[name]
				? readQuota(name, servers[name])
				: Promise.resolve<QuotaResult>({ agent: name, status: "unavailable", reason: "unknown agent" }),
		),
	);
	const used = names.flatMap((n) => {
		const u = usageFor(n);
		return u ? [`${n}: ${u.totalTokens} tokens over ${u.turns} turn(s) (in ${u.inputTokens}, out ${u.outputTokens})`] : [];
	});
	return { text: `${renderQuota(results)}${used.length ? `\n\nTokens used this session:\n${used.join("\n")}` : ""}`, results };
}
