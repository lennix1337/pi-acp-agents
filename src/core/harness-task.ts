import { AcpClient, type HarnessProgress } from "./client.js";
import type { AcpAgentConfig } from "pi-acp-types";

/** The slice of AcpClient a one-shot worker task needs. */
export interface HarnessTaskClient {
	connect(): Promise<void>;
	initialize(): Promise<unknown>;
	newSession(): Promise<string>;
	prompt(message: string): Promise<{ text: string; stopReason: string }>;
	dispose(): Promise<void>;
}

export type HarnessTaskPhase = "connect" | "initialize" | "newSession" | "prompt";

export type HarnessTaskResult =
	| { ok: true; text: string; stopReason: string; updates: number }
	| { ok: false; error: string; phase: HarnessTaskPhase };

export interface HarnessTaskOptions {
	prompt: string;
	timeoutMs: number;
	/** Build the client; `onProgress` must be wired as its harness progress callback. */
	createClient: (onProgress: (event: HarnessProgress) => void) => HarnessTaskClient;
}

/**
 * One non-interactive worker task: connect, handshake, one session, one prompt, always dispose.
 * Never throws: a failure or a hung step becomes `{ ok: false, phase }` so the caller can report it.
 * The timeout covers the whole run; permission requests are cancelled by the client itself.
 */
export async function runHarnessTask(opts: HarnessTaskOptions): Promise<HarnessTaskResult> {
	let updates = 0;
	const client = opts.createClient((event) => {
		if (event.type === "update") updates++;
	});
	let phase: HarnessTaskPhase = "connect";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${opts.timeoutMs} ms`)), opts.timeoutMs);
	});
	const run = async (): Promise<HarnessTaskResult> => {
		await client.connect();
		phase = "initialize";
		await client.initialize();
		phase = "newSession";
		await client.newSession();
		phase = "prompt";
		const { text, stopReason } = await client.prompt(opts.prompt);
		return { ok: true, text, stopReason, updates };
	};
	try {
		return await Promise.race([run(), timeout]);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), phase };
	} finally {
		clearTimeout(timer);
		await client.dispose().catch(() => undefined);
	}
}

/** Convenience: run a task against an external ACP agent executable (e.g. `agy acp`). */
export function runAcpWorkerTask(args: {
	agentName: string;
	config: AcpAgentConfig;
	cwd?: string;
	prompt: string;
	timeoutMs: number;
}): Promise<HarnessTaskResult> {
	return runHarnessTask({
		prompt: args.prompt,
		timeoutMs: args.timeoutMs,
		createClient: (onProgress) =>
			new AcpClient({ agentName: args.agentName, config: args.config, cwd: args.cwd, harness: { onProgress } }),
	});
}
