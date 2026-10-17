import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CODEX_TURN_METADATA_KEY } from "../../src/codex/context.js";
import { type StdioSession, startCli, textOf } from "./helpers/stdio.js";

const sessions: StdioSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

async function start(): Promise<StdioSession> {
	const session = await startCli();
	sessions.push(session);
	return session;
}

describe("codex-lsp MCP entry", () => {
	it("#given Codex turn metadata naming the workspace #when a relative path is used #then it resolves inside that workspace", async () => {
		// given
		const { client, workspace, write } = await start();
		write("main.fake", "abc\n");

		// when
		const result = await client.callTool({
			name: "goto_definition",
			arguments: { filePath: "main.fake", line: 1, character: 0 },
			_meta: { [CODEX_TURN_METADATA_KEY]: { session_id: "s", turn_id: "t", workspaces: { [workspace]: {} } } },
		});

		// then
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({ locations: [{ path: join(workspace, "main.fake") }] });
	});

	it("#given no Codex metadata #when a relative path is used #then the plugin directory is not mistaken for the workspace", async () => {
		// given
		const { client } = await start();

		// when
		const result = await client.callTool({
			name: "goto_definition",
			arguments: { filePath: "package.json", line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("[invalid_path]");
	});

	it("#given the plugin entry #when listing tools #then the standard tools and both hook endpoints are present", async () => {
		// given
		const { client } = await start();

		// when
		const { tools } = await client.listTools();

		// then
		expect(tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["hover", "rename", "pre_edit_snapshot", "post_edit_diagnostics"]),
		);
		expect(tools).toHaveLength(14);
	});
	it("#given an unusable launcher binding #when tools, status, and the edit hook run without their own environment #then each reports it instead of using the process environment", async () => {
		// given
		const session = await startCli({ CODEX_LSP_CONTEXT_ID: "../../not-an-id" });
		sessions.push(session);
		const path = session.write("main.fake", "ERROR\n");

		// when
		const definition = await session.client.callTool({
			name: "goto_definition",
			arguments: { filePath: path, line: 1, character: 0 },
		});
		const status = await session.client.callTool({ name: "status", arguments: { workspaceRoot: session.workspace } });
		const event = { sessionId: "s", toolUseId: "t", cwd: session.workspace, toolName: "apply_patch" };
		const patch = { command: `*** Begin Patch\n*** Update File: ${path}\n@@\n*** End Patch` };
		await session.client.callTool({ name: "pre_edit_snapshot", arguments: { ...event, toolInput: patch } });
		const hook = await session.client.callTool({
			name: "post_edit_diagnostics",
			arguments: { ...event, toolInput: patch, toolResponse: "Exit code: 0" },
		});

		// then
		expect(definition.isError).toBe(true);
		expect(textOf(definition)).toContain("[environment_error] the launcher's environment binding is unusable");
		expect(status.isError).toBe(true);
		expect(status.structuredContent).toMatchObject({
			environmentError: expect.stringContaining("CODEX_LSP_CONTEXT_ID is not a valid environment id"),
		});
		expect(textOf(hook)).toContain("failed: [environment_error]");
		expect(session.fakeLog()).toEqual([]);
	});
});
