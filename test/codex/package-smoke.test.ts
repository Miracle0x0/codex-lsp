import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { placeholder } from "./helpers/placeholder.js";

type JsonRecord = Record<string, unknown>;

function readJson(path: string): JsonRecord {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new TypeError(`Expected a JSON object: ${path}`);
	return parsed;
}

function record(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) throw new TypeError(`Expected object at ${label}`);
	return value;
}

describe("plugin package metadata", () => {
	it("#given package.json #when validating runtime wiring #then pnpm and direct runtime dependencies are pinned", () => {
		// given
		const packageJson = readJson("package.json");

		// then
		expect(packageJson["type"]).toBe("module");
		expect(packageJson["packageManager"]).toBe("pnpm@12.11.2");
		expect(record(packageJson["dependencies"], "dependencies")["@modelcontextprotocol/server"]).toBe("2.3.1");
		expect(record(packageJson["bin"], "bin")["codex-lsp"]).toBe("./dist/cli.js");
		expect(readFileSync("src/cli.ts", "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
	});

	it("#given the Codex compat plugin layout #when validating manifests #then MCP and hooks resolve inside the plugin root", () => {
		// given
		const packageJson = readJson("package.json");
		const pluginJson = readJson(".codex-plugin/plugin.json");
		const mcpJson = readJson(".mcp.json");

		// when
		const lspServer = record(record(mcpJson["mcpServers"], "mcpServers")["lsp"], "mcpServers.lsp");
		const files = packageJson["files"];

		// then
		expect(pluginJson["version"]).toBe(packageJson["version"]);
		expect(pluginJson["hooks"]).toBe("./hooks/hooks.json");
		expect(pluginJson["mcpServers"]).toBe("./.mcp.json");
		expect(pluginJson["skills"]).toBe("./skills/");
		expect(lspServer["command"]).toBe("node");
		expect(lspServer["args"]).toEqual(["./dist/cli.js", "mcp"]);
		expect(lspServer["cwd"]).toBe(".");
		expect(lspServer["env_vars"]).toEqual(["CODEX_LSP_CONTEXT_ID", "CODEX_LSP_ENV_MANIFEST"]);
		expect(files).toEqual(expect.arrayContaining([".codex-plugin", ".mcp.json", "hooks", "skills", "dist"]));
	});

	it("#given the plugin hooks #when validating #then PreToolUse and PostToolUse call the lsp hook endpoints", () => {
		// given
		const hooks = record(readJson("hooks/hooks.json")["hooks"], "hooks");
		const mcpJson = readJson(".mcp.json");
		const lspServer = record(record(mcpJson["mcpServers"], "mcpServers")["lsp"], "mcpServers.lsp");

		// when
		const handler = (event: string): JsonRecord => {
			const groups = hooks[event];
			if (!Array.isArray(groups) || groups.length !== 1) throw new TypeError(`Expected one ${event} group`);
			const group = record(groups[0], `${event}[0]`);
			expect(group["matcher"]).toBe("^(apply_patch|Bash)$");
			const handlers = group["hooks"];
			if (!Array.isArray(handlers) || handlers.length !== 1) throw new TypeError(`Expected one ${event} hook`);
			return record(handlers[0], `${event}[0].hooks[0]`);
		};

		// then
		expect(handler("PreToolUse")).toMatchObject({ type: "mcp_tool", server: "lsp", tool: "pre_edit_snapshot" });
		expect(handler("PostToolUse")).toMatchObject({
			type: "mcp_tool",
			server: "lsp",
			tool: "post_edit_diagnostics",
			// Whole-value placeholders keep the JSON type of the event fields.
			input: { toolInput: placeholder("tool_input"), toolResponse: placeholder("tool_response") },
		});
		expect(record(lspServer["env"], "env")["CODEX_MCP_PROTOCOL_VERSION"]).toBe("2026-07-28");
	});

	it("#given LSP skill guidance #when validating MCP tool instructions #then tool names are not framed as shell commands", () => {
		// given
		const skill = readFileSync("skills/lsp/SKILL.md", "utf8");

		// then
		expect(skill.includes("through the tool interface")).toBe(true);
		expect(skill.includes("not shell commands")).toBe(true);
	});
});

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
