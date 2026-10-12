import { describe, expect, it } from "vitest";
import { createAdapter } from "../../src/adapter-factory.js";

describe("custom adapter naming", () => {
	it("is named after the configured server so usage and activity are attributed to it", () => {
		const adapter = createAdapter("agy", { command: "uvx", args: ["agy-acp"] }, {} as never);
		expect(adapter.name).toBe("agy");
	});
});
