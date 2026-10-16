import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CODEX_TURN_METADATA_KEY } from "../src/codex-context.js";
import { requireBuiltCli, type StdioSession, startCli, textOf } from "./helpers/stdio.js";

const sessions: StdioSession[] = [];

beforeAll(requireBuiltCli);

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
});
