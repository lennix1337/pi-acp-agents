/**
 * Remaining-quota reporting for ACP agents.
 *
 * ACP has no quota method, so each agent profile may declare a
 * `quota_command` (argv array, no shell) that prints one JSON object:
 *   { "remaining": number, "limit"?: number, "unit"?: string,
 *     "resetsAt"?: string, "detail"?: string, "buckets"?: Bucket[] }
 * where the headline reading is the binding limit and `buckets` lists every
 * limit the backend enforces ({ "name", "remaining", "limit"?, "unit"?, "resetsAt"? }).
 * Agents without a source report that plainly instead of guessing.
 */
import { execFile } from "node:child_process";

import type { AcpAgentConfig } from "../config/types.js";
import { usageFor } from "../core/usage-ledger.js";

export interface QuotaBucket {
	name: string;
	remaining: number;
	limit?: number;
	unit?: string;
	resetsAt?: string;
}

export interface QuotaReading {
	remaining: number;
	limit?: number;
	unit?: string;
	resetsAt?: string;
	detail?: string;
	buckets?: QuotaBucket[];
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
	const reading: QuotaReading = { ...parseFigures(o) };
	if (typeof o.detail === "string") reading.detail = o.detail;
	if (o.buckets !== undefined) {
		if (!Array.isArray(o.buckets)) throw new Error("quota JSON 'buckets' must be an array");
		reading.buckets = o.buckets.map((b) => {
			if (typeof b !== "object" || b === null) throw new Error("quota bucket must be an object");
			const bucket = b as Record<string, unknown>;
			if (typeof bucket.name !== "string") throw new Error("quota bucket needs a string 'name'");
			return { name: bucket.name, ...parseFigures(bucket) };
		});
	}
	return reading;
}

function parseFigures(o: Record<string, unknown>): Omit<QuotaBucket, "name"> {
	if (typeof o.remaining !== "number" || !Number.isFinite(o.remaining) || o.remaining < 0) {
		throw new Error("quota JSON needs a non-negative numeric 'remaining'");
	}
	const figures: Omit<QuotaBucket, "name"> = { remaining: o.remaining };
	if (typeof o.limit === "number" && Number.isFinite(o.limit)) figures.limit = o.limit;
	for (const key of ["unit", "resetsAt"] as const) {
		if (typeof o[key] === "string") figures[key] = o[key] as string;
	}
	return figures;
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

function renderFigures({ remaining, limit, unit, resetsAt }: Omit<QuotaBucket, "name">): string {
	const of = limit === undefined ? "" : ` of ${limit}`;
	return `${remaining}${of} ${unit ?? "units"} left${resetsAt ? `, resets ${resetsAt}` : ""}`;
}

export function renderQuota(results: QuotaResult[]): string {
	return results
		.map((r) => {
			if (r.status === "unavailable") return `${r.agent}: unavailable — ${r.reason}`;
			const { detail, buckets } = r.reading;
			const lines = [`${r.agent}: ${renderFigures(r.reading)}${detail ? ` — ${detail}` : ""}`];
			for (const b of buckets ?? []) lines.push(`  ${b.name}: ${renderFigures(b)}`);
			return lines.join("\n");
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
