import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { placeholder } from "./helpers/placeholder.js";
import { REPO_ROOT, requireBuiltCli } from "./helpers/stdio.js";

const CLI = join(REPO_ROOT, "dist", "cli.js");
const roots: string[] = [];
const hasTomllib = spawnSync("python3", ["-c", "import tomllib"]).status === 0;

beforeAll(requireBuiltCli);

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parseToml(text: string): Record<string, unknown> {
	const result = spawnSync(
		"python3",
		["-I", "-c", "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
		{
			input: text,
			encoding: "utf8",
		},
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe.runIf(hasTomllib)("codex-lsp config mcp", () => {
	it("#given no pinned environment #when printing config #then it is valid TOML with the server, protocol, and both hooks", () => {
		// when
		const result = spawnSync(process.execPath, [CLI, "config", "mcp"], { encoding: "utf8" });

		// then
		expect(result.status).toBe(0);
		const config = parseToml(result.stdout);
		expect(config).toMatchObject({
			features: { mcp_2026_07_28: true },
			mcp_servers: {
				lsp: {
					args: [CLI, "mcp"],
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
		// given
		const stateDir = mkdtempSync(join(tmpdir(), "codex-lsp-config-"));
		roots.push(stateDir);

		// when
		const result = spawnSync(process.execPath, [CLI, "config", "mcp", "--environment-id", "env-missing-01"], {
			env: { ...process.env, CODEX_LSP_STATE_DIR: stateDir },
			encoding: "utf8",
		});

		// then
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("no captured environment env-missing-01");
	});
});
