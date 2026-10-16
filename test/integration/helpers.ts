import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROJECT_CONFIG_ENV, USER_CONFIG_ENV } from "../../src/core/config/loader.js";
import { type DiagnosticBatch, DiagnosticBatchSchema } from "../../src/core/diagnostics/batch-schema.js";
import { writeSnapshot } from "../../src/core/environment/snapshot.js";
import { findExecutable } from "../../src/core/lsp/command.js";
import type { ToolCallContext } from "../../src/core/runtime/context.js";
import { createLspRuntime, type LspRuntime } from "../../src/core/runtime/runtime.js";
import { CallsOutputSchema, PrepareCallHierarchyOutputSchema } from "../../src/core/tools/call-hierarchy.js";
import { LSP_TOOLS } from "../../src/core/tools/index.js";
import { HoverOutputSchema, LocationsOutputSchema } from "../../src/core/tools/navigation.js";

export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Integration tests fail loudly when a required tool is missing instead of skipping. */
export function requireTool(name: string): string {
	const found = findExecutable(name, process.env);
	if (found === undefined) throw new Error(`integration test requires '${name}' on PATH`);
	return found;
}

export interface Workspace {
	readonly root: string;
	readonly stateDir: string;
	readonly runtime: LspRuntime;
	write(path: string, content: string): string;
	snapshot(environmentId: string, env: Record<string, string | undefined>): void;
	call(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ summary: string; data: Record<string, unknown>; partial: boolean }>;
	close(): Promise<void>;
}

export function createWorkspace(config?: unknown): Workspace {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lsp-it-")));
	const stateDir = join(root, ".state");
	mkdirSync(stateDir);
	const saved = { project: process.env[PROJECT_CONFIG_ENV], user: process.env[USER_CONFIG_ENV] };
	delete process.env[PROJECT_CONFIG_ENV];
	process.env[USER_CONFIG_ENV] = join(root, ".no-user-config.json");
	if (config !== undefined) {
		mkdirSync(join(root, ".codex"), { recursive: true });
		writeFileSync(join(root, ".codex", "lsp-client.json"), JSON.stringify(config));
	}
	const runtime = createLspRuntime({ defaultWorkspaceRoot: root, stateDir });
	const context: ToolCallContext = { signal: new AbortController().signal };
	return {
		root,
		stateDir,
		runtime,
		write(path, content) {
			const full = join(root, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, content);
			return full;
		},
		snapshot(environmentId, env) {
			writeSnapshot(stateDir, { environmentId, kind: "shell", executionContextId: environmentId, cwd: root, env });
		},
		async call(name, args) {
			const tool = LSP_TOOLS.find((candidate) => candidate.name === name);
			if (!tool) throw new Error(`unknown tool ${name}`);
			const result = await tool.run(runtime, args, context);
			return { summary: result.summary, data: result.data, partial: result.partial === true };
		},
		async close() {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
			if (saved.project === undefined) delete process.env[PROJECT_CONFIG_ENV];
			else process.env[PROJECT_CONFIG_ENV] = saved.project;
			if (saved.user === undefined) delete process.env[USER_CONFIG_ENV];
			else process.env[USER_CONFIG_ENV] = saved.user;
		},
	};
}

/** Environment of a shell that activated the venv: its bin first on PATH and VIRTUAL_ENV set. */
export function activatedVenv(venv: string, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	const bin = join(venv, process.platform === "win32" ? "Scripts" : "bin");
	return { ...base, VIRTUAL_ENV: venv, PATH: [bin, base["PATH"] ?? ""].join(delimiter) };
}

export function activatedConda(
	prefix: string,
	base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
	const { VIRTUAL_ENV: _venv, ...rest } = base;
	return {
		...rest,
		CONDA_PREFIX: prefix,
		CONDA_DEFAULT_ENV: prefix.split(/[\\/]/).at(-1),
		CONDA_SHLVL: "1",
		PATH: [join(prefix, "bin"), base["PATH"] ?? ""].join(delimiter),
	};
}

export function createVenv(path: string): string {
	execFileSync(requireTool("python3"), ["-m", "venv", "--without-pip", path], { stdio: "pipe" });
	return path;
}

export function venvPython(venv: string): string {
	return join(
		venv,
		process.platform === "win32" ? "Scripts" : "bin",
		process.platform === "win32" ? "python.exe" : "python",
	);
}

/** Installs a pure-Python module into a venv without pip or network access. */
export function installModule(venv: string, name: string, source: string): void {
	const purelib = execFileSync(venvPython(venv), ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
		encoding: "utf8",
	}).trim();
	mkdirSync(join(purelib, name), { recursive: true });
	writeFileSync(join(purelib, name, "__init__.py"), source);
}

/** Gives a temp TypeScript project the explicitly selected TypeScript SDK. */
export function linkTypeScript(root: string, version: 6 | 7 = 6): void {
	mkdirSync(join(root, "node_modules"), { recursive: true });
	symlinkSync(
		join(PACKAGE_ROOT, "node_modules", version === 6 ? "typescript6" : "typescript"),
		join(root, "node_modules", "typescript"),
		"dir",
	);
}

/** Validates a tool's structured output as a diagnostics batch. */
export function batchOf(data: unknown): DiagnosticBatch {
	return DiagnosticBatchSchema.parse(data);
}

/** Public position (1-based line, code-point column) of the nth occurrence of a token in a file's text. */
export function positionOf(text: string, token: string, occurrence = 0): { line: number; character: number } {
	let offset = -1;
	for (let index = 0; index <= occurrence; index += 1) {
		offset = text.indexOf(token, offset + 1);
		if (offset === -1) throw new Error(`'${token}' occurrence ${occurrence} not found`);
	}
	const before = text.slice(0, offset).split("\n");
	return { line: before.length, character: [...(before.at(-1) ?? "")].length };
}

export const locationsOf = (data: unknown) => LocationsOutputSchema.parse(data).locations;
export const hoverOf = (data: unknown) => HoverOutputSchema.parse(data).hover;
export const callItemsOf = (data: unknown) => PrepareCallHierarchyOutputSchema.parse(data).items;
export const callsOf = (data: unknown) => CallsOutputSchema.parse(data).calls;
