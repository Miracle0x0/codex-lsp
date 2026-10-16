#!/usr/bin/env node
// Build a self-contained Codex plugin directory from the workspace.
//
// Codex copies an installed plugin into its cache without symbolic links, so the
// staged directory must use a hoisted node_modules layout and contain no links.
//
// Usage:
//   node scripts/package-plugin.mjs [--out <dir>] [--verify]
//
// --verify copies the staged plugin to a fresh directory outside the source tree
// and checks that the MCP entry starts and lists its tools from there.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@code-yeongyu/codex-lsp";
const requiredFiles = [
	".codex-plugin/plugin.json",
	".mcp.json",
	"hooks/hooks.json",
	"skills/lsp/SKILL.md",
	"dist/cli.js",
	"node_modules/@code-yeongyu/lsp-tools-mcp/package.json",
];
const forbiddenPackages = ["typescript", "vitest", "@biomejs/biome", "pyright", "typescript-language-server"];
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

function requireBuiltWorkspace() {
	const builtEntries = [join(repoRoot, "dist", "cli.js"), join(repoRoot, "packages", "lsp-tools-mcp", "dist", "cli.js")];
	const missing = builtEntries.filter((entry) => !existsSync(entry));
	if (missing.length > 0) {
		fail(`missing build output (${missing.map((entry) => relative(repoRoot, entry)).join(", ")}); run pnpm run build:all first`);
	}
}

function deploy(out) {
	rmSync(out, { recursive: true, force: true });
	const result = spawnSync(
		"pnpm",
		["--filter", packageName, "--prod", "deploy", out, "--config.node-linker=hoisted"],
		{ cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
	);
	if (result.status !== 0) fail(`pnpm deploy failed with status ${result.status ?? "null"}`);
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

function listToolsFrom(pluginDir) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, ["./dist/cli.js", "mcp"], {
			cwd: pluginDir,
			env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			rejectPromise(new Error(`MCP entry did not answer within 10s\n${stderr}`));
		}, 10_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				const message = JSON.parse(line);
				if (message.id === 2) {
					clearTimeout(timer);
					child.stdin.end();
					resolvePromise(message.result?.tools?.map((tool) => tool.name) ?? []);
					return;
				}
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			rejectPromise(error);
		});
		const requests = [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-plugin", version: "0" } },
			},
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
		];
		child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
	});
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
requireBuiltWorkspace();
deploy(options.out);
stripLinkSurfaces(options.out);
verifyLayout(options.out);
console.log(`package-plugin: staged ${options.out}`);
if (options.verify) await verifyRelocated(options.out);
