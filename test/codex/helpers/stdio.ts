import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { isolatedContext } from "../../support/context.js";
import { CLI_PATH, REPO_ROOT, repoPath } from "../../support/repo.js";

const FAKE_SERVER = repoPath("test", "core", "fixtures", "fake-lsp-server.mjs");

export interface StdioSession {
	readonly client: Client;
	/** Process id of the CLI serving this session. */
	readonly pid: number | null;
	/** Real path of a fresh temporary workspace. */
	readonly workspace: string;
	write(path: string, content: string): string;
	/** Messages the fake language server received. */
	fakeLog(): Array<{ readonly method?: string; readonly pid?: number }>;
	close(): Promise<void>;
}

/**
 * Starts dist/cli.js like Codex does (cwd = plugin directory) with a fake `.fake` language server. The CLI sees
 * only an isolated environment: a private home and state directory and the test's own configuration files.
 */
export async function startCli(extraEnv: Record<string, string> = {}): Promise<StdioSession> {
	const context = isolatedContext("codex-lsp-test");
	const workspace = context.root;
	const configPath = join(workspace, "lsp-client.json");
	const logPath = join(workspace, "fake-lsp.log");
	writeFileSync(
		configPath,
		JSON.stringify({
			schemaVersion: 1,
			servers: { fake: { command: [process.execPath, FAKE_SERVER], env: { FAKE_LSP_LOG: logPath } } },
			languages: { fake: { extensions: [".fake"], semanticServer: "fake", diagnosticServers: ["fake"] } },
		}),
	);
	const client = new Client({ name: "codex-lsp-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [CLI_PATH, "mcp"],
		cwd: REPO_ROOT,
		env: { ...context.env, LSP_TOOLS_MCP_PROJECT_CONFIG: configPath, ...extraEnv },
	});
	await client.connect(transport);
	return {
		client,
		get pid() {
			return transport.pid;
		},
		workspace,
		write(path, content) {
			const full = join(workspace, path);
			writeFileSync(full, content);
			return full;
		},
		fakeLog() {
			if (!existsSync(logPath)) return [];
			return readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as { method?: string; pid?: number });
		},
		async close() {
			await client.close();
			context.cleanup();
		},
	};
}

export function textOf(result: { content?: unknown }): string {
	const content = Array.isArray(result.content) ? result.content : [];
	return content.map((block: { text?: string }) => block.text ?? "").join("\n");
}
