import { afterAll, describe, it } from "vitest";

import { createMcpHarness, type FakeLspBehavior, type McpHarness } from "../core/helpers/mcp-harness.js";

/**
 * Measures diagnostics latency against the fake language server and prints the numbers. Nothing here passes or
 * fails on a duration: the results depend on the machine and its load, so they are reported, not asserted.
 */
const results: Array<{ readonly scenario: string; readonly ms: number }> = [];

afterAll(() => {
	process.stdout.write(
		`\ncodex-lsp diagnostics timings (${process.platform}, node ${process.version}):\n${results
			.map(({ scenario, ms }) => `  ${scenario.padEnd(56)} ${ms.toFixed(1).padStart(8)} ms`)
			.join("\n")}\n`,
	);
});

async function timed<T>(scenario: string, action: () => Promise<T>): Promise<T> {
	const started = performance.now();
	const value = await action();
	results.push({ scenario, ms: performance.now() - started });
	return value;
}

async function withHarness(behavior: FakeLspBehavior, run: (h: McpHarness) => Promise<void>): Promise<void> {
	const h = await createMcpHarness(behavior);
	try {
		await run(h);
	} finally {
		await h.close();
	}
}

const check = (h: McpHarness) => h.client.callTool({ name: "diagnostics", arguments: { filePath: "a.fake" } });

describe("diagnostics latency", () => {
	it("cold start, warm recheck, and edits", async () => {
		await withHarness({}, async (h) => {
			h.writeFile("a.fake", "ERROR\n");
			await timed("first check (starts the server)", () => check(h));
			await timed("unchanged recheck (confirmed snapshot)", () => check(h));
			h.writeFile("a.fake", "ERROR\nWARN\n");
			await timed("check after an edit", () => check(h));
		});
	});

	it("a server that skips republishing unchanged results", async () => {
		await withHarness({ skipUnchanged: true, clearOnClose: true }, async (h) => {
			h.writeFile("a.fake", "ERROR one\n");
			await check(h);
			h.writeFile("a.fake", "ERROR one\n\n");
			await timed("first unchanged-result edit (settle wait, then reopen)", () => check(h));
			h.writeFile("a.fake", "ERROR one\n\n\n");
			await timed("later unchanged-result edit (reopens at once)", () => check(h));
		});
	});
});
