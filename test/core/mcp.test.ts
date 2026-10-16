import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { createLspServerFactory } from "../../src/core/mcp/server.js";
import { createLspRuntime } from "../../src/core/runtime/runtime.js";
import { createMcpHarness, type McpHarness, waitFor } from "./helpers/mcp-harness.js";

const harnesses: McpHarness[] = [];

async function harness(...args: Parameters<typeof createMcpHarness>): Promise<McpHarness> {
	const created = await createMcpHarness(...args);
	harnesses.push(created);
	return created;
}

afterEach(async () => {
	for (const created of harnesses.splice(0)) await created.close();
});

function textOf(result: { content?: unknown }): string {
	const content = Array.isArray(result.content) ? result.content : [];
	return content.map((block: { text?: string }) => block.text ?? "").join("\n");
}

describe("lsp MCP server (2026-07-28)", () => {
	it("#given a slow tool #when progress is requested #then start arrives before completion", async () => {
		const { client, writeFile } = await harness({ requestDelays: { "textDocument/hover": 500 } });
		writeFile("a.fake", "abc\n");
		const messages: string[] = [];
		let finished = false;
		const call = client
			.callTool(
				{ name: "hover", arguments: { filePath: "a.fake", line: 1, character: 0 } },
				{ onprogress: (progress) => messages.push(progress.message ?? "") },
			)
			.finally(() => {
				finished = true;
			});
		try {
			await waitFor(() => messages.length > 0, 2000);
			expect(finished).toBe(false);
		} finally {
			await call;
		}
		expect(messages).toEqual(["Starting hover", "Completed hover"]);
	});

	it("#given a modern client #when listing tools #then exposes the standard tools with schemas and annotations", async () => {
		// given
		const { client } = await harness();

		// when
		const { tools } = await client.listTools();

		// then
		expect(tools.map((tool) => tool.name)).toEqual([
			"status",
			"diagnostics",
			"goto_definition",
			"goto_implementation",
			"find_references",
			"hover",
			"symbols",
			"prepare_call_hierarchy",
			"incoming_calls",
			"outgoing_calls",
			"prepare_rename",
			"rename",
		]);
		for (const tool of tools) expect(tool.outputSchema?.["type"]).toBe("object");
		const definition = tools.find((tool) => tool.name === "goto_definition");
		expect(definition?.inputSchema.properties?.["line"]).toMatchObject({ type: "integer", minimum: 1 });
		expect(definition?.inputSchema.properties?.["character"]).toMatchObject({ type: "integer", minimum: 0 });
		expect(definition?.annotations?.readOnlyHint).toBe(true);
		const rename = tools.find((tool) => tool.name === "rename");
		expect(rename?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(client.getInstructions()).toContain("1-based line");
	});

	it("#given status #when called #then returns structured server state without starting a language server", async () => {
		// given
		const { client, runtime } = await harness();

		// when
		const result = await client.callTool({ name: "status", arguments: {} });

		// then
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({ clients: [] });
		expect(textOf(result)).toContain("Environment: unbound");
		expect(runtime.manager.clientCount()).toBe(0);
	});

	it("#given a legacy lsp_ alias #when called #then it is not a registered tool", async () => {
		// given
		const { client } = await harness();

		// when
		const call = client.callTool({ name: "lsp_status", arguments: {} });

		// then
		await expect(call).rejects.toThrow("Tool lsp_status not found");
	});

	it("#given a fractional line #when calling goto_definition #then input validation rejects it", async () => {
		// given
		const { client, writeFile } = await harness();
		const file = writeFile("a.fake", "abc\n");

		// when
		const result = await client.callTool({
			name: "goto_definition",
			arguments: { filePath: file, line: 1.5, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Input validation error");
	});

	it("#given no workspace root #when passing a relative path #then fails with invalid_path instead of using the server cwd", async () => {
		// given
		const { client } = await harness({}, { defaultWorkspaceRoot: null });

		// when
		const result = await client.callTool({
			name: "goto_definition",
			arguments: { filePath: "a.fake", line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^\[invalid_path\]/);
	});

	it("#given a fake language server #when calling goto_definition #then returns 1-based structured locations", async () => {
		// given
		const { client, writeFile } = await harness();
		const file = writeFile("a.fake", "abc\n");

		// when
		const result = await client.callTool({
			name: "goto_definition",
			arguments: { filePath: "a.fake", line: 1, character: 1 },
		});

		// then
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			server: "fake",
			locations: [{ path: file, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } }],
		});
	});

	it("#given an unconfigured extension #when calling a navigation tool #then reports server_not_configured", async () => {
		// given
		const { client, writeFile } = await harness();
		writeFile("notes.unknownext", "x\n");

		// when
		const result = await client.callTool({
			name: "goto_definition",
			arguments: { filePath: "notes.unknownext", line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^\[server_not_configured\]/);
	});

	it("#given concurrent read-only calls #when both run #then both complete on one shared client", async () => {
		// given
		const { client, runtime, writeFile } = await harness();
		writeFile("a.fake", "abc\n");
		writeFile("b.fake", "def\n");

		// when
		const [first, second] = await Promise.all([
			client.callTool({ name: "goto_definition", arguments: { filePath: "a.fake", line: 1, character: 0 } }),
			client.callTool({ name: "find_references", arguments: { filePath: "b.fake", line: 1, character: 0 } }),
		]);

		// then
		expect(first.isError).toBeUndefined();
		expect(second.isError).toBeUndefined();
		expect(runtime.manager.clientCount()).toBe(1);
	});

	it("#given a slow request #when the MCP call is cancelled #then $/cancelRequest reaches the language server", async () => {
		// given
		const { client, writeFile, readLog } = await harness({ requestDelays: { "textDocument/definition": 10_000 } });
		writeFile("a.fake", "abc\n");
		const controller = new AbortController();

		// when
		const call = client.callTool(
			{ name: "goto_definition", arguments: { filePath: "a.fake", line: 1, character: 0 } },
			{ signal: controller.signal },
		);
		await waitFor(() => readLog().some((entry) => entry.method === "textDocument/definition"), 5000);
		controller.abort("user stopped");

		// then
		await expect(call).rejects.toThrow();
		await waitFor(() => readLog().some((entry) => entry.kind === "cancelled"), 3000);
	});
});

describe("lsp MCP server legacy posture", () => {
	it("#given a 2025-era initialize #when sent to the handler #then it is rejected with the supported revision", async () => {
		// given
		const runtime = createLspRuntime();
		const handler = createMcpHandler(createLspServerFactory(runtime, { version: "0.0.0-test" }), {
			legacy: "reject",
		});

		// when
		const response = await handler.fetch(
			new Request("http://lsp.test/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "0" } },
				}),
			}),
		);
		const body: unknown = await response.json();

		// then
		expect(body).toMatchObject({ error: { code: -32022, data: { supported: ["2026-07-28"] } } });
		await handler.close();
		await runtime.dispose();
	});
});
