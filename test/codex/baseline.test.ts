import { describe, expect, it } from "vitest";

import { type BatchDiagnostic, diffDiagnostics } from "../../src/codex/hook/baseline.js";

function diagnostic(message: string, line: number, providerId = "pyright"): BatchDiagnostic {
	return {
		path: "/w/a.py",
		providerId,
		severity: "error",
		code: "reportX",
		message,
		range: { start: { line, character: 0 }, end: { line, character: 1 } },
	};
}

describe("diagnostic diff", () => {
	it("#given lines shifted by an edit #when diffing #then unchanged problems are not reported as new", () => {
		// given
		const before = [diagnostic("a", 1), diagnostic("b", 5)];
		const after = [diagnostic("a", 3), diagnostic("b", 7), diagnostic("c", 9)];

		// when
		const { added, resolved } = diffDiagnostics(before, after);

		// then
		expect(added.map((item) => item.message)).toEqual(["c"]);
		expect(resolved).toEqual([]);
	});

	it("#given a repeated problem #when one copy is fixed #then exactly one is resolved", () => {
		// given
		const before = [diagnostic("dup", 1), diagnostic("dup", 2)];
		const after = [diagnostic("dup", 1)];

		// when
		const { added, resolved } = diffDiagnostics(before, after);

		// then
		expect(added).toEqual([]);
		expect(resolved).toHaveLength(1);
	});

	it("#given the same message from two providers #when diffing #then they are distinct problems", () => {
		// given / when
		const { added } = diffDiagnostics([diagnostic("x", 1, "pyright")], [diagnostic("x", 1, "ruff")]);

		// then
		expect(added.map((item) => item.providerId)).toEqual(["ruff"]);
	});
});
