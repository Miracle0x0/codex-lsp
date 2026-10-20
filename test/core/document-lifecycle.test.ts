import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createMcpHarness, type FakeLspBehavior, type McpHarness, waitFor } from "./helpers/mcp-harness.js";

const harnesses: McpHarness[] = [];

async function harness(behavior: FakeLspBehavior = {}): Promise<McpHarness> {
	const created = await createMcpHarness(behavior);
	harnesses.push(created);
	return created;
}

afterEach(async () => {
	for (const created of harnesses.splice(0)) await created.close();
});

describe("request document lifetime", () => {
	it.each(["push", "pull"] as const)(
		"#given many files and a %s server #when checks finish #then documents and diagnostics are released while the server is reused",
		async (diagnosticMode) => {
			const h = await harness({ diagnosticMode, clearOnClose: true });
			for (let index = 0; index < 12; index += 1) {
				const path = h.writeFile(`file-${index}.fake`, "ERROR\n");
				const result = await h.client.callTool({ name: "diagnostics", arguments: { filePath: path } });
				expect(result.isError).not.toBe(true);
				expect(result.structuredContent).toMatchObject({ counts: { error: 1 } });
				const [client] = h.runtime.manager.activeClients();
				expect(client).toBeDefined();
				expect(client?.documents.size).toBe(0);
				expect(client?.pullCache.size).toBe(0);
				expect(client?.latestPublished(pathToFileURL(path).href)).toBeUndefined();
			}
			expect(h.readLog().filter((entry) => entry.method === "initialize")).toHaveLength(1);
			expect(h.readLog().filter((entry) => entry.method === "textDocument/didOpen")).toHaveLength(12);
			expect(h.readLog().filter((entry) => entry.method === "textDocument/didClose")).toHaveLength(12);
		},
	);

	it("#given overlapping navigation and diagnostics for one file #when diagnostics finish first #then the document stays open until navigation completes", async () => {
		const h = await harness({ requestDelays: { "textDocument/definition": 500 } });
		h.writeFile("a.fake", "ERROR\n");
		const navigation = h.client.callTool({
			name: "goto_definition",
			arguments: { filePath: "a.fake", line: 1, character: 0 },
		});
		await waitFor(() => h.readLog().some((entry) => entry.method === "textDocument/definition"));
		try {
			const diagnostics = await h.client.callTool({ name: "diagnostics", arguments: { filePath: "a.fake" } });
			expect(diagnostics.structuredContent).toMatchObject({ counts: { error: 1 } });
			expect(h.runtime.manager.snapshot()[0]?.openDocuments).toBe(1);
			expect(h.readLog().filter((entry) => entry.method === "textDocument/didClose")).toHaveLength(0);
		} finally {
			expect((await navigation).isError).not.toBe(true);
		}
		expect(h.runtime.manager.snapshot()[0]?.openDocuments).toBe(0);
		expect(h.readLog().filter((entry) => entry.method === "textDocument/didOpen")).toHaveLength(1);
		expect(h.readLog().filter((entry) => entry.method === "textDocument/didClose")).toHaveLength(1);
	});

	it("#given simultaneous first requests for one file #when both complete #then there is one balanced open and close", async () => {
		const h = await harness({ requestDelays: { "textDocument/definition": 50 } });
		h.writeFile("a.fake", "abc\n");
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				h.client.callTool({
					name: "goto_definition",
					arguments: { filePath: "a.fake", line: 1, character: 0 },
				}),
			),
		);
		expect(results.every((result) => result.isError !== true)).toBe(true);
		expect(h.runtime.manager.snapshot()[0]?.openDocuments).toBe(0);
		expect(h.readLog().filter((entry) => entry.method === "textDocument/didOpen")).toHaveLength(1);
		expect(h.readLog().filter((entry) => entry.method === "textDocument/didClose")).toHaveLength(1);
	});

	it("#given a cancelled MCP request #when cancellation reaches the server #then its document is closed", async () => {
		const h = await harness({ requestDelays: { "textDocument/definition": 10_000 } });
		h.writeFile("a.fake", "abc\n");
		const controller = new AbortController();
		const pending = h.client.callTool(
			{ name: "goto_definition", arguments: { filePath: "a.fake", line: 1, character: 0 } },
			{ signal: controller.signal },
		);
		const rejected = expect(pending).rejects.toThrow();
		await waitFor(() => h.readLog().some((entry) => entry.method === "textDocument/definition"));
		controller.abort();
		await rejected;
		await waitFor(() => h.readLog().some((entry) => entry.method === "textDocument/didClose"));
		expect(h.runtime.manager.snapshot()[0]?.openDocuments).toBe(0);
	});

	it("#given diagnostics arriving after timeout #when the file is reopened with fixed content #then the old version is not reported", async () => {
		const h = await harness({ publishDelayMs: 400 });
		const path = h.writeFile("a.fake", "ERROR\n");
		const first = await h.client.callTool({
			name: "diagnostics",
			arguments: { filePath: path, timeoutMs: 100 },
		});
		expect(first.isError).toBe(true);
		expect(h.runtime.manager.snapshot()[0]?.openDocuments).toBe(0);
		h.writeFile("a.fake", "fixed\n");
		const second = await h.client.callTool({
			name: "diagnostics",
			arguments: { filePath: path, timeoutMs: 2000 },
		});
		expect(second.isError).not.toBe(true);
		expect(second.structuredContent).toMatchObject({ complete: true, counts: { total: 0 } });
		expect(h.runtime.manager.activeClients()[0]?.latestPublished(pathToFileURL(path).href)).toBeUndefined();
	});

	it("#given a server that does not request open-close notifications #when navigating #then no open-close notifications are sent", async () => {
		const h = await harness({ capabilities: { textDocumentSync: { openClose: false, change: 0 } } });
		h.writeFile("a.fake", "abc\n");
		const result = await h.client.callTool({
			name: "hover",
			arguments: { filePath: "a.fake", line: 1, character: 0 },
		});
		expect(result.isError).not.toBe(true);
		expect(h.readLog().filter((entry) => entry.method?.startsWith("textDocument/did"))).toEqual([]);
		expect(h.runtime.manager.snapshot()[0]?.openDocuments).toBe(0);
	});
});
