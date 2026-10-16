import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
	it("#given package.json #when validating workspace wiring #then pnpm and the workspace runtime are pinned", () => {
		// given
		const packageJson = readJson("package.json");

		// then
		expect(packageJson["type"]).toBe("module");
		expect(packageJson["packageManager"]).toBe("pnpm@12.11.2");
		expect(record(packageJson["dependencies"], "dependencies")["@code-yeongyu/lsp-tools-mcp"]).toBe("workspace:*");
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
