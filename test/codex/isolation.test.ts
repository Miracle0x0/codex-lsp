import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedContext, toolchainEnv } from "../support/context.js";
import { type StdioSession, startCli } from "./helpers/stdio.js";

/** What a developer's shell might export: broken configuration, an active venv, a bound environment, Node flags. */
const BROKEN_CONFIG = join(tmpdir(), "codex-lsp-isolation-broken.json");
const POLLUTION = {
	LSP_TOOLS_MCP_USER_CONFIG: BROKEN_CONFIG,
	LSP_TOOLS_MCP_PROJECT_CONFIG: BROKEN_CONFIG,
	VIRTUAL_ENV: "/envs/developer",
	CONDA_PREFIX: "/opt/conda/envs/developer",
	CODEX_LSP_CONTEXT_ID: "env-developer-shell",
	NODE_OPTIONS: "--require=/nonexistent/codex-lsp-preload.js",
};

const saved = new Map<string, string | undefined>();
const sessions: StdioSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	saved.clear();
	rmSync(BROKEN_CONFIG, { force: true });
});

function pollute(): void {
	writeFileSync(BROKEN_CONFIG, "{ not json");
	for (const [name, value] of Object.entries(POLLUTION)) {
		saved.set(name, process.env[name]);
		process.env[name] = value;
	}
}

describe("test isolation", () => {
	it("#given a polluted parent environment #when a fixture context is created #then none of it reaches child processes", () => {
		// given
		pollute();

		// when
		const context = isolatedContext("codex-lsp-isolation");
		const toolchain = toolchainEnv();
		context.cleanup();

		// then
		for (const name of Object.keys(POLLUTION)) {
			expect(context.env[name]).toBeUndefined();
			expect(toolchain[name]).toBeUndefined();
		}
		expect(context.env["HOME"]).toBe(context.home);
		expect(context.config).toEqual({ env: {}, homeDir: context.home });
	});

	it("#given a polluted parent environment #when the CLI fixture runs #then it serves tools with only the test's configuration", async () => {
		// given
		pollute();

		// when
		const session = await startCli();
		sessions.push(session);
		session.write("main.fake", "abc\n");
		const result = await session.client.callTool({
			name: "goto_definition",
			arguments: { filePath: join(session.workspace, "main.fake"), line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBeUndefined();
		expect(session.fakeLog().some((entry) => entry.method === "initialize")).toBe(true);
	});
});
