/** Cumulative token usage per agent, fed by ACP `PromptResponse.usage`. */
export interface TokenUsage {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
}

const ledger = new Map<string, TokenUsage & { turns: number }>();

export function recordUsage(agent: string, usage: TokenUsage | null | undefined): void {
	if (!usage) return;
	const entry = ledger.get(agent) ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
	entry.totalTokens += usage.totalTokens;
	entry.inputTokens += usage.inputTokens;
	entry.outputTokens += usage.outputTokens;
	entry.turns += 1;
	ledger.set(agent, entry);
}

export function usageFor(agent: string): (TokenUsage & { turns: number }) | undefined {
	return ledger.get(agent);
}

export function resetUsageLedger(): void {
	ledger.clear();
}
