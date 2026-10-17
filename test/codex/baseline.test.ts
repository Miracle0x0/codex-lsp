import { describe, expect, it } from "vitest";

import { BaselineStore, type BatchDiagnostic, diffDiagnostics, projectBatch } from "../../src/codex/hook/baseline.js";
import type { DiagnosticBatch } from "../../src/core/index.js";

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

function batchOf(files: DiagnosticBatch["files"], diagnostics: DiagnosticBatch["diagnostics"]): DiagnosticBatch {
	return {
		target: "test",
		scope: "files",
		workspaceRoot: "/w",
		environment: { environmentId: "env", generation: 2, source: "active-shell" },
		complete: true,
		incompleteReasons: [],
		providers: [],
		files,
		coverage: {
			scannedFiles: 0,
			checkedFiles: 0,
			unsupportedFiles: 0,
			unsupportedExtensions: [],
			excludedDirectories: 0,
		},
		minimumSeverity: "warning",
		counts: { total: diagnostics.length, error: diagnostics.length, warning: 0, information: 0, hint: 0 },
		diagnostics,
		shown: diagnostics.length,
		truncated: false,
	};
}

describe("batch projection and baseline replacement", () => {
	it("#given two providers and one unconfirmed result #when projecting #then each file has its providers, problems, and confirmation", () => {
		// given
		const batch = batchOf(
			[
				{ path: "/w/a.py", serverId: "pyright", documentVersion: 1, freshness: "confirmed" },
				{ path: "/w/a.py", serverId: "ruff", documentVersion: 1, freshness: "unconfirmed" },
				{ path: "/w/b.py", serverId: "pyright", documentVersion: 1, freshness: "observed" },
			],
			[diagnostic("a", 1), { ...diagnostic("b", 2), path: "/w/b.py" }],
		);

		// when
		const files = projectBatch(batch);

		// then
		expect(files.get("/w/a.py")).toMatchObject({
			environmentKey: "active-shell:env#2",
			providers: ["pyright", "ruff"],
			confirmed: false,
		});
		expect(files.get("/w/a.py")?.diagnostics.map((item) => item.message)).toEqual(["a"]);
		expect(files.get("/w/b.py")).toMatchObject({ providers: ["pyright"], confirmed: true });
	});

	it("#given a baseline #when an unconfirmed result is recorded #then the old baseline stays", () => {
		// given
		const store = new BaselineStore();
		store.record(
			"s",
			batchOf(
				[{ path: "/w/a.py", serverId: "pyright", documentVersion: 1, freshness: "confirmed" }],
				[diagnostic("old", 1)],
			),
		);

		// when
		store.record(
			"s",
			batchOf([{ path: "/w/a.py", serverId: "pyright", documentVersion: 2, freshness: "unconfirmed" }], []),
		);

		// then
		expect(store.get("s", "/w/a.py")?.diagnostics.map((item) => item.message)).toEqual(["old"]);
	});
});
