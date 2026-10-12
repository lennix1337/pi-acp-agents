import { describe, expect, it } from "vitest";

import { parseQuotaOutput, readQuota, renderQuota } from "../../src/quota/quota.js";

describe("quota", () => {
	it("parses a valid reading and ignores unknown fields", () => {
		expect(parseQuotaOutput('{"remaining":55,"unit":"freebucks","x":1}')).toEqual({
			remaining: 55,
			unit: "freebucks",
		});
	});

	it("rejects non-JSON, non-objects and bad remaining", () => {
		expect(() => parseQuotaOutput("nope")).toThrow(/JSON/);
		expect(() => parseQuotaOutput("[]")).toThrow(/remaining/);
		expect(() => parseQuotaOutput('{"remaining":-1}')).toThrow(/remaining/);
		expect(() => parseQuotaOutput('{"remaining":"5"}')).toThrow(/remaining/);
	});

	it("reports unavailable without a quota_command", async () => {
		const r = await readQuota("agy", { command: "x" });
		expect(r.status).toBe("unavailable");
	});

	it("runs the command without a shell and renders the reading", async () => {
		const r = await readQuota("a", {
			quota_command: [process.execPath, "-e", 'console.log(JSON.stringify({remaining:3,limit:10,unit:"req"}))'],
		});
		expect(r).toEqual({ agent: "a", status: "ok", reading: { remaining: 3, limit: 10, unit: "req" } });
		expect(renderQuota([r])).toBe("a: 3 of 10 req left");
	});

	it("turns a failing command into unavailable instead of throwing", async () => {
		const r = await readQuota("a", { quota_command: [process.execPath, "-e", "process.exit(2)"] });
		expect(r.status).toBe("unavailable");
	});
});
