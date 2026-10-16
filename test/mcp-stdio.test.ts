import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CODEX_TURN_METADATA_KEY } from "../src/codex-context.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");
const FAKE_SERVER = join(REPO_ROOT, "packages", "lsp-tools-mcp", "test", "fixtures", "fake-lsp-server.mjs");
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(() => {
	if (!existsSync(CLI_PATH)) throw new Error(`${CLI_PATH} is missing; run pnpm run build:all first`);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(workspace: string): Promise<Client> {
	const configPath = join(workspace, "lsp-client.json");
	writeFileSync(
		configPath,
		JSON.stringify({ lsp: { fake: { command: [process.execPath, FAKE_SERVER], extensions: [".fake"] } } }),
	);
	const client = new Client({ name: "codex-lsp-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [CLI_PATH, "mcp"],
			// Codex starts plugin MCP servers from the plugin directory, not the user's workspace.
			cwd: REPO_ROOT,
			env: {
				PATH: process.env["PATH"] ?? "",
				HOME: process.env["HOME"] ?? "",
				LSP_TOOLS_MCP_PROJECT_CONFIG: configPath,
				LSP_TOOLS_MCP_USER_CONFIG: join(workspace, "no-user-config.json"),
			},
		}),
	);
	cleanups.push(() => client.close());
	return client;
}

describe("codex-lsp MCP entry", () => {
	it("#given Codex turn metadata naming the workspace #when a relative path is used #then it resolves inside that workspace", async () => {
		// given
		const workspace = mkdtempSync(join(tmpdir(), "codex-lsp-mcp-"));
		cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
		writeFileSync(join(workspace, "main.fake"), "abc\n");
		const client = await connect(workspace);

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
		const workspace = mkdtempSync(join(tmpdir(), "codex-lsp-mcp-"));
		cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
		const client = await connect(workspace);

		// when
		const result = await client.callTool({
			name: "goto_definition",
			arguments: { filePath: "package.json", line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("[invalid_path]");
	});
});
