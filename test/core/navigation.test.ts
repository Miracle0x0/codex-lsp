import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeSnapshot } from "../../src/core/environment/snapshot.js";
import { createMcpHarness, type FakeLspBehavior, type HarnessOptions, type McpHarness } from "./helpers/mcp-harness.js";

const harnesses: McpHarness[] = [];
const stateDirectories: string[] = [];

async function harness(behavior: FakeLspBehavior = {}, options: HarnessOptions = {}): Promise<McpHarness> {
	const created = await createMcpHarness(behavior, options);
	harnesses.push(created);
	return created;
}

afterEach(async () => {
	for (const created of harnesses.splice(0)) await created.close();
	for (const directory of stateDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function textOf(result: { content?: unknown }): string {
	const content = Array.isArray(result.content) ? result.content : [];
	return content.map((block: { text?: string }) => block.text ?? "").join("\n");
}

interface CallItem {
	readonly handle: string;
	readonly name: string;
	readonly path: string;
	readonly range: { readonly start: { readonly line: number; readonly character: number } };
}

interface Calls {
	readonly calls: ReadonlyArray<{ readonly item: CallItem; readonly fromRanges: readonly unknown[] }>;
}

function itemsOf(result: { structuredContent?: unknown }): readonly CallItem[] {
	return (result.structuredContent as { items: readonly CallItem[] }).items;
}

describe("hover", () => {
	it("#given a non-ASCII line #when hovering #then the position is sent in UTF-16 and the range returned in code points", async () => {
		// given
		const range = { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } };
		const { client, writeFile, readLog } = await harness({
			hoverResult: { contents: { kind: "plaintext", value: "const abc: number" }, range },
		});
		writeFile("a.fake", "😀😀abc\n");

		// when
		const result = await client.callTool({ name: "hover", arguments: { filePath: "a.fake", line: 1, character: 2 } });

		// then
		const request = readLog().find((entry) => entry.method === "textDocument/hover");
		expect(request?.params).toMatchObject({ position: { line: 0, character: 4 } });
		expect(result.structuredContent).toEqual({
			server: "fake",
			hover: {
				kind: "plaintext",
				contents: "const abc: number",
				range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
			},
		});
	});

	it("#given deprecated MarkedString contents #when hovering #then they are joined into one markdown block", async () => {
		// given
		const { client, writeFile } = await harness({
			hoverResult: { contents: ["Docs line", { language: "ts", value: "let x: number" }] },
		});
		writeFile("a.fake", "abc\n");

		// when
		const result = await client.callTool({ name: "hover", arguments: { filePath: "a.fake", line: 1, character: 0 } });

		// then
		expect(result.structuredContent).toEqual({
			server: "fake",
			hover: { kind: "markdown", contents: "Docs line\n\n```ts\nlet x: number\n```" },
		});
	});

	it("#given no hover information #when hovering #then hover is null rather than an error", async () => {
		// given
		const { client, writeFile } = await harness({ hoverResult: null });
		writeFile("a.fake", "abc\n");

		// when
		const result = await client.callTool({ name: "hover", arguments: { filePath: "a.fake", line: 1, character: 0 } });

		// then
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({ server: "fake", hover: null });
		expect(textOf(result)).toBe("No hover information");
	});
});

describe("goto_implementation", () => {
	it("#given a LocationLink result #when asking for implementations #then the target selection range is returned", async () => {
		// given
		const { client, writeFile } = await harness();
		const file = writeFile("a.fake", "abc\nimpl\n");

		// when
		const result = await client.callTool({
			name: "goto_implementation",
			arguments: { filePath: "a.fake", line: 1, character: 0 },
		});

		// then
		expect(result.structuredContent).toEqual({
			server: "fake",
			locations: [{ path: file, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }],
		});
	});

	it("#given a server without implementationProvider #when asking #then capability_unsupported is reported", async () => {
		// given
		const { client, writeFile } = await harness({ capabilities: { implementationProvider: false } });
		writeFile("a.fake", "abc\n");

		// when
		const result = await client.callTool({
			name: "goto_implementation",
			arguments: { filePath: "a.fake", line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^\[capability_unsupported\] fake does not support textDocument\/implementation/);
	});
});

describe("call hierarchy", () => {
	it.each(["environment", "configuration"] as const)(
		"#given a prepared handle #when %s changes #then it is invalidated",
		async (change) => {
			const stateDir = mkdtempSync(join(tmpdir(), "lsp-hierarchy-env-"));
			stateDirectories.push(stateDir);
			const environmentId = "env-hierarchy-test";
			const capture = (value: string) =>
				writeSnapshot(stateDir, {
					environmentId,
					kind: "shell",
					executionContextId: "shell",
					cwd: stateDir,
					env: { ...process.env, TEST_HIERARCHY_ENV: value },
					extraVariables: ["TEST_HIERARCHY_ENV"],
				});
			capture("one");
			const h = await harness({}, { stateDir, defaultEnvironmentId: environmentId });
			h.writeFile("a.fake", "abc\n");
			const [item] = itemsOf(
				await h.client.callTool({
					name: "prepare_call_hierarchy",
					arguments: { filePath: "a.fake", line: 1, character: 0 },
				}),
			);
			if (item === undefined) throw new Error("no item");
			if (change === "environment") capture("two");
			else {
				const config = JSON.parse(readFileSync(join(h.workspace, "lsp-client.json"), "utf8")) as {
					servers: { fake: { env: Record<string, string> } };
				};
				config.servers.fake.env["TEST_HIERARCHY_CONFIG"] = "changed";
				h.writeFile("lsp-client.json", JSON.stringify(config));
			}
			const result = await h.client.callTool({ name: "outgoing_calls", arguments: { item: item.handle } });
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("prepare_call_hierarchy again");
			expect(h.readLog().filter((entry) => entry.method === "callHierarchy/outgoingCalls")).toHaveLength(0);
		},
	);

	it("#given a handle #when its document changes #then prepare is required again", async () => {
		const h = await harness();
		h.writeFile("a.fake", "abc\n");
		const [item] = itemsOf(
			await h.client.callTool({
				name: "prepare_call_hierarchy",
				arguments: { filePath: "a.fake", line: 1, character: 0 },
			}),
		);
		if (item === undefined) throw new Error("no item");
		h.writeFile("a.fake", "\nabc\n");
		const result = await h.client.callTool({ name: "outgoing_calls", arguments: { item: item.handle } });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("prepare_call_hierarchy again");
	});

	it("#given a handle from an old client #when the server restarts #then the old private data is rejected", async () => {
		const h = await harness();
		h.writeFile("a.fake", "abc\n");
		const [item] = itemsOf(
			await h.client.callTool({
				name: "prepare_call_hierarchy",
				arguments: { filePath: "a.fake", line: 1, character: 0 },
			}),
		);
		if (item === undefined) throw new Error("no item");
		const client = h.runtime.manager.activeClients()[0];
		if (client === undefined) throw new Error("no client");
		await client.stop();
		const result = await h.client.callTool({ name: "outgoing_calls", arguments: { item: item.handle } });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("prepare_call_hierarchy again");
		expect(h.readLog().filter((entry) => entry.method === "callHierarchy/outgoingCalls")).toHaveLength(0);
	});

	it("#given a well-formed modified handle #when calling #then it is rejected", async () => {
		const h = await harness();
		h.writeFile("a.fake", "abc\n");
		const [item] = itemsOf(
			await h.client.callTool({
				name: "prepare_call_hierarchy",
				arguments: { filePath: "a.fake", line: 1, character: 0 },
			}),
		);
		if (item === undefined) throw new Error("no item");
		const decoded = JSON.parse(Buffer.from(item.handle, "base64url").toString("utf8")) as { item: { name: string } };
		decoded.item.name = "forged";
		const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");
		const result = await h.client.callTool({ name: "outgoing_calls", arguments: { item: forged } });
		expect(result.isError).toBe(true);
	});

	it("#given a prepared item #when walking outgoing calls twice #then each handle carries the server's private data", async () => {
		// given
		const { client, writeFile, readLog } = await harness();
		const file = writeFile("a.fake", "abc\nroot\n");
		const prepared = await client.callTool({
			name: "prepare_call_hierarchy",
			arguments: { filePath: "a.fake", line: 2, character: 1 },
		});
		const [root] = itemsOf(prepared);
		if (root === undefined) throw new Error("no item prepared");

		// when
		const first = (await client.callTool({ name: "outgoing_calls", arguments: { item: root.handle } }))
			.structuredContent as Calls;
		const nested = first.calls[0]?.item;
		if (nested === undefined) throw new Error("no outgoing call");
		const second = (await client.callTool({ name: "outgoing_calls", arguments: { item: nested.handle } }))
			.structuredContent as Calls;

		// then
		expect(root).toMatchObject({ name: "root", path: file, range: { start: { line: 2, character: 0 } } });
		expect(first.calls[0]).toMatchObject({
			item: { name: "outgoing-1" },
			fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }],
		});
		expect(second.calls[0]?.item.name).toBe("outgoing-2");
		const sent = readLog()
			.filter((entry) => entry.method === "callHierarchy/outgoingCalls")
			.map((entry) => (entry.params as { item: { data: unknown } }).item.data);
		expect(sent).toEqual([
			{ depth: 0, token: "server-private" },
			{ depth: 1, token: "server-private" },
		]);
	});

	it("#given a prepared item #when asking incoming calls #then callers come back with their call sites", async () => {
		// given
		const { client, writeFile } = await harness();
		writeFile("a.fake", "abc\n");
		const [root] = itemsOf(
			await client.callTool({
				name: "prepare_call_hierarchy",
				arguments: { filePath: "a.fake", line: 1, character: 0 },
			}),
		);
		if (root === undefined) throw new Error("no item prepared");

		// when
		const result = await client.callTool({ name: "incoming_calls", arguments: { item: root.handle } });

		// then
		expect(result.structuredContent).toMatchObject({ server: "fake", calls: [{ item: { name: "incoming-1" } }] });
		expect(textOf(result)).toContain("incoming-1 (Function)");
	});

	it("#given a tampered handle #when asking calls #then the input is rejected before any server is started", async () => {
		// given
		const { client, runtime } = await harness();
		const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
		const forged = encode({ v: 1, server: "fake", item: { name: "x" } });
		const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
		const remote = encode({
			v: 1,
			server: "fake",
			workspaceRoot: null,
			environmentId: null,
			item: { name: "x", kind: 12, uri: "http://example.com/a.fake", range, selectionRange: range },
		});

		// when
		const garbage = await client.callTool({ name: "incoming_calls", arguments: { item: "not-a-handle" } });
		const invalid = await client.callTool({ name: "outgoing_calls", arguments: { item: forged } });
		const nonFile = await client.callTool({ name: "outgoing_calls", arguments: { item: remote } });

		// then
		expect(textOf(garbage)).toMatch(/^\[invalid_input\]/);
		expect(textOf(invalid)).toMatch(/^\[invalid_input\] 'item' is not a valid call hierarchy handle/);
		expect(textOf(nonFile)).toContain("item uri must be a file URI");
		expect(runtime.manager.clientCount()).toBe(0);
	});

	it("#given a server without callHierarchyProvider #when preparing #then capability_unsupported is reported", async () => {
		// given
		const { client, writeFile } = await harness({ capabilities: { callHierarchyProvider: false } });
		writeFile("a.fake", "abc\n");

		// when
		const result = await client.callTool({
			name: "prepare_call_hierarchy",
			arguments: { filePath: "a.fake", line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^\[capability_unsupported\]/);
	});
});
