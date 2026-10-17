import { spawnSync } from "node:child_process";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { type IsolatedContext, isolatedContext } from "../support/context.js";
import { CLI_PATH } from "../support/repo.js";
import { placeholder } from "./helpers/placeholder.js";

const contexts: IsolatedContext[] = [];

afterEach(() => {
	for (const context of contexts.splice(0)) context.cleanup();
});

function configMcp(...args: string[]) {
	const context = isolatedContext("codex-lsp-config");
	contexts.push(context);
	return spawnSync(process.execPath, [CLI_PATH, "config", "mcp", ...args], { env: context.env, encoding: "utf8" });
}

describe("codex-lsp config mcp", () => {
	it("#given no pinned environment #when printing config #then it is valid TOML with the server, protocol, and both hooks", () => {
		// when
		const result = configMcp();

		// then
		expect(result.status).toBe(0);
		expect(parse(result.stdout)).toMatchObject({
			features: { mcp_2026_07_28: true },
			mcp_servers: {
				lsp: {
					args: [CLI_PATH, "mcp"],
					env: { CODEX_MCP_PROTOCOL_VERSION: "2026-07-28" },
					env_vars: ["CODEX_LSP_CONTEXT_ID", "CODEX_LSP_ENV_MANIFEST"],
				},
			},
			hooks: {
				PreToolUse: [{ matcher: "^(apply_patch|Bash)$", hooks: [{ type: "mcp_tool", tool: "pre_edit_snapshot" }] }],
				PostToolUse: [
					{ hooks: [{ type: "mcp_tool", tool: "post_edit_diagnostics", input: { cwd: placeholder("cwd") } }] },
				],
			},
		});
	});

	it("#given an environment that was never captured #when pinning it #then the command refuses", () => {
		// when
		const result = configMcp("--environment-id", "env-missing-01");

		// then
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("no captured environment env-missing-01");
	});
});
