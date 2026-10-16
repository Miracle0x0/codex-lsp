import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");
const FAKE_SERVER = join(REPO_ROOT, "test", "core", "fixtures", "fake-lsp-server.mjs");

export interface StdioSession {
	readonly client: Client;
	/** Real path of a fresh temporary workspace. */
	readonly workspace: string;
	write(path: string, content: string): string;
	/** Messages the fake language server received. */
	fakeLog(): Array<{ readonly method?: string; readonly pid?: number }>;
	close(): Promise<void>;
}

export function requireBuiltCli(): void {
	if (!existsSync(CLI_PATH)) throw new Error(`${CLI_PATH} is missing; run pnpm run build first`);
}

/** Starts dist/cli.js like Codex does (cwd = plugin directory) with a fake `.fake` language server. */
export async function startCli(extraEnv: Record<string, string> = {}): Promise<StdioSession> {
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codex-lsp-test-")));
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
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [CLI_PATH, "mcp"],
			cwd: REPO_ROOT,
			env: {
				PATH: process.env["PATH"] ?? "",
				HOME: process.env["HOME"] ?? "",
				LSP_TOOLS_MCP_PROJECT_CONFIG: configPath,
				LSP_TOOLS_MCP_USER_CONFIG: join(workspace, "no-user-config.json"),
				...extraEnv,
			},
		}),
	);
	return {
		client,
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
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}

export function textOf(result: { content?: unknown }): string {
	const content = Array.isArray(result.content) ? result.content : [];
	return content.map((block: { text?: string }) => block.text ?? "").join("\n");
}
