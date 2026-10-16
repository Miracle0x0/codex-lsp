import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageMetadata {
	readonly dependencies: Record<string, string>;
	readonly bin: Record<string, string>;
	readonly files: readonly string[];
}

describe("single-package project layout", () => {
	it("#given the repository #when checking source ownership #then core and Codex code belong to one package", () => {
		expect(existsSync(".gitmodules")).toBe(false);
		expect(existsSync("pnpm-workspace.yaml")).toBe(false);
		expect(existsSync("packages/lsp-tools-mcp")).toBe(false);
		expect(existsSync("src/core/runtime/runtime.ts")).toBe(true);
		expect(existsSync("src/codex/context.ts")).toBe(true);
	});

	it("#given the published package #when checking dependencies #then it directly owns the runtime dependencies and documentation", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageMetadata;
		expect(Object.keys(pkg.dependencies).sort()).toEqual([
			"@modelcontextprotocol/server",
			"vscode-jsonrpc",
			"vscode-languageserver-protocol",
			"zod",
		]);
		expect(Object.values(pkg.dependencies).some((version) => version.startsWith("workspace:"))).toBe(false);
		expect(pkg.bin).toEqual({ "codex-lsp": "./dist/cli.js" });
		expect(pkg.files).toEqual(expect.arrayContaining(["dist", "docs", "DESIGN-zh.md"]));
	});
});
