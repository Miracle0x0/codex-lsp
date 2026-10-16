#!/usr/bin/env node
// Stage a self-contained Codex plugin from this single package and its production dependencies.
//
// Codex copies an installed plugin into its cache without symbolic links, so the
// staged directory must use a hoisted node_modules layout and contain no links.
//
// Usage:
//   node scripts/package-plugin.mjs [--out <dir>] [--verify]
//
// --verify copies the staged plugin to a fresh directory outside the source tree
// and checks that the MCP entry answers a 2026-07-28 client from there.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
	".codex-plugin/plugin.json",
	".mcp.json",
	"hooks/hooks.json",
	"skills/lsp/SKILL.md",
	"shell/codex-lsp.bash",
	"shell/codex-lsp.zsh",
	"shell/codex-lsp.ps1",
	"dist/cli.js",
	"dist/core/index.js",
	"dist/codex/context.js",
	"docs/README.md",
];
const forbiddenPackages = ["@code-yeongyu/lsp-tools-mcp", "typescript", "typescript6", "vitest", "@biomejs/biome", "pyright", "typescript-language-server"];
const deployMetadata = ["pnpm-lock.yaml", "pnpm-workspace.yaml"];

function parseArgs(argv) {
	const options = { out: join(repoRoot, "artifacts", "codex-lsp-plugin"), verify: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--verify") {
			options.verify = true;
		} else if (arg === "--out") {
			const value = argv[index + 1];
			if (!value) fail("--out requires a directory");
			options.out = resolve(value);
			index += 1;
		} else {
			fail(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function fail(message) {
	console.error(`package-plugin: ${message}`);
	process.exit(1);
}

function requireBuild() {
	const builtEntries = [join(repoRoot, "dist", "cli.js"), join(repoRoot, "dist", "core", "index.js")];
	const missing = builtEntries.filter((entry) => !existsSync(entry));
	if (missing.length > 0) {
		fail(`missing build output (${missing.map((entry) => relative(repoRoot, entry)).join(", ")}); run pnpm run build first`);
	}
}

function stage(out) {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	for (const path of ["package.json", "pnpm-lock.yaml", ...pkg.files]) {
		cpSync(join(repoRoot, path), join(out, path), { recursive: true });
	}
	const result = spawnSync(
		"pnpm",
		["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--ignore-workspace", "--config.node-linker=hoisted"],
		{ cwd: out, stdio: "inherit", shell: process.platform === "win32" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) fail(`production dependency install failed with status ${result.status ?? "null"}`);
}

function walk(dir, visit) {
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		const stat = lstatSync(fullPath);
		if (visit(fullPath, entry, stat) === "skip") continue;
		if (stat.isDirectory()) walk(fullPath, visit);
	}
}

function stripLinkSurfaces(out) {
	for (const file of deployMetadata) rmSync(join(out, file), { force: true });
	walk(out, (fullPath, entry, stat) => {
		if (entry === ".bin" && stat.isDirectory()) {
			rmSync(fullPath, { recursive: true, force: true });
			return "skip";
		}
		return undefined;
	});
}

function verifyLayout(out) {
	const problems = [];
	walk(out, (fullPath, _entry, stat) => {
		if (stat.isSymbolicLink()) problems.push(`symbolic link: ${relative(out, fullPath)}`);
		return undefined;
	});
	for (const file of requiredFiles) {
		if (!existsSync(join(out, file))) problems.push(`missing: ${file}`);
	}
	for (const name of forbiddenPackages) {
		if (existsSync(join(out, "node_modules", name))) problems.push(`unexpected bundled package: ${name}`);
	}
	if (problems.length > 0) fail(`invalid plugin layout in ${out}:\n  ${problems.join("\n  ")}`);
}

async function listToolsFrom(pluginDir) {
	const client = new Client({ name: "package-plugin", version: "0" }, { versionNegotiation: { mode: "auto" } });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["./dist/cli.js", "mcp"],
		cwd: pluginDir,
		env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
	});
	const timeout = setTimeout(() => {
		void client.close();
	}, 15_000);
	try {
		await client.connect(transport);
		const { tools } = await client.listTools();
		return tools.map((tool) => tool.name);
	} finally {
		clearTimeout(timeout);
		await client.close();
	}
}

async function verifyRelocated(out) {
	const relocatedRoot = mkdtempSync(join(tmpdir(), "codex-lsp-plugin-"));
	const relocated = join(relocatedRoot, "codex-lsp");
	try {
		cpSync(out, relocated, { recursive: true });
		const tools = await listToolsFrom(relocated);
		if (tools.length === 0) fail("relocated plugin listed no MCP tools");
		console.log(`package-plugin: relocated plugin at ${relocated} lists ${tools.length} tools: ${tools.join(", ")}`);
	} finally {
		rmSync(relocatedRoot, { recursive: true, force: true });
	}
}

const options = parseArgs(process.argv.slice(2));
requireBuild();
stage(options.out);
stripLinkSurfaces(options.out);
verifyLayout(options.out);
console.log(`package-plugin: staged ${options.out}`);
if (options.verify) await verifyRelocated(options.out);
