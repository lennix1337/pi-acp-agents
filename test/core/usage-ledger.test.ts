import { beforeEach, describe, expect, it } from "vitest";

import { recordUsage, resetUsageLedger, usageFor } from "../../src/core/usage-ledger.js";

describe("usage ledger", () => {
	beforeEach(resetUsageLedger);

	it("accumulates per agent and ignores missing usage", () => {
		recordUsage("agy", { totalTokens: 10, inputTokens: 6, outputTokens: 4 });
		recordUsage("agy", { totalTokens: 5, inputTokens: 3, outputTokens: 2 });
		recordUsage("agy", undefined);
		expect(usageFor("agy")).toEqual({ totalTokens: 15, inputTokens: 9, outputTokens: 6, turns: 2 });
		expect(usageFor("other")).toBeUndefined();
	});
});
