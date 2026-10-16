import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpHarness, type FakeLspBehavior, type McpHarness } from "./helpers/mcp-harness.js";

const harnesses: McpHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(behavior: FakeLspBehavior): Promise<McpHarness> {
	const created = await createMcpHarness(behavior);
	harnesses.push(created);
	return created;
}

const span = (line: number, start: number, end: number) => ({
	start: { line, character: start },
	end: { line, character: end },
});

describe("rename through the edit coordinator", () => {
	it("#given more than 200 diagnostics #when renaming #then the baseline result remains complete", async () => {
		const h = await harness({
			renameEdit: { changes: { "$ROOT/a.fake": [{ range: span(0, 0, 3), newText: "$NEW" }] } },
		});
		h.writeFile("a.fake", `old\n${"ERROR\n".repeat(201)}`);
		const result = await h.client.callTool({
			name: "rename",
			arguments: { filePath: "a.fake", line: 1, character: 0, newName: "new" },
		});
		expect(result.structuredContent).toMatchObject({
			diagnostics: { counts: { error: 201 }, shown: 201, truncated: false },
		});
	});

	it("#given a cross-file edit #when renaming #then both files are written, open documents resync, and diagnostics follow", async () => {
		// given
		const h = await harness({
			renameEdit: {
				changes: {
					"$ROOT/a.fake": [{ range: span(0, 0, 3), newText: "$NEW" }],
					"$ROOT/b.fake": [{ range: span(1, 4, 7), newText: "$NEW" }],
				},
			},
		});
		h.writeFile("a.fake", "old = 1\n");
		h.writeFile("b.fake", "ok\nuse old\n");

		// when
		const result = await h.client.callTool({
			name: "rename",
			arguments: { filePath: "a.fake", line: 1, character: 0, newName: "ERROR" },
		});

		// then
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(h.workspace, "a.fake"), "utf8")).toBe("ERROR = 1\n");
		expect(readFileSync(join(h.workspace, "b.fake"), "utf8")).toBe("ok\nuse ERROR\n");
		const data = result.structuredContent as {
			applied: boolean;
			editCount: number;
			operationId: string;
			diagnostics: { counts: { error: number }; files: Array<{ path: string; documentVersion: number }> };
		};
		expect(data).toMatchObject({ applied: true, editCount: 2 });
		expect(data.operationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(data.diagnostics.counts.error).toBe(2);
		const changes = h.readLog().filter((entry) => entry.method === "textDocument/didChange");
		expect(changes.length).toBeGreaterThanOrEqual(1);
	});

	it("#given an edit computed for an older document version #when renaming #then nothing is written", async () => {
		// given
		const h = await harness({
			renameEdit: {
				documentChanges: [
					{
						textDocument: { uri: "$ROOT/a.fake", version: 99 },
						edits: [{ range: span(0, 0, 3), newText: "$NEW" }],
					},
				],
			},
		});
		h.writeFile("a.fake", "old = 1\n");

		// when
		const result = await h.client.callTool({
			name: "rename",
			arguments: { filePath: "a.fake", line: 1, character: 0, newName: "fresh" },
		});

		// then
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("[edit_failed]");
		expect(readFileSync(join(h.workspace, "a.fake"), "utf8")).toBe("old = 1\n");
	});

	it("#given a resource rename and a text edit #when renaming #then the file moves and the edit lands in the new path", async () => {
		// given
		const h = await harness({
			renameEdit: {
				documentChanges: [
					{ kind: "rename", oldUri: "$ROOT/a.fake", newUri: "$ROOT/moved/a.fake" },
					{
						textDocument: { uri: "$ROOT/moved/a.fake", version: null },
						edits: [{ range: span(0, 0, 3), newText: "$NEW" }],
					},
				],
			},
		});
		h.writeFile("a.fake", "old = 1\n");

		// when
		const result = await h.client.callTool({
			name: "rename",
			arguments: { filePath: "a.fake", line: 1, character: 0, newName: "fresh" },
		});

		// then
		expect(result.isError).toBeUndefined();
		expect(readFileSync(join(h.workspace, "moved", "a.fake"), "utf8")).toBe("fresh = 1\n");
		expect(result.structuredContent).toMatchObject({
			changes: [
				{ path: join(h.workspace, "a.fake"), kind: "deleted" },
				{ path: join(h.workspace, "moved", "a.fake"), kind: "created" },
				{ path: join(h.workspace, "moved", "a.fake"), kind: "changed" },
			],
		});
		const closed = h.readLog().some((entry) => entry.method === "textDocument/didClose");
		expect(closed).toBe(true);
	});
});
