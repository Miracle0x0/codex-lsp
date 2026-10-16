import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { stableHash } from "../../config/loader.js";
import { findExecutable } from "../../lsp/command.js";
import { runProbe } from "../probe.js";
import { ancestors, firstLine, sourceLabel, type ToolchainAdapter } from "./types.js";

const DATABASE_NAMES = ["compile_commands.json", "compile_flags.txt"] as const;
const BUILD_DIRECTORIES = ["", "build", "out", "cmake-build-debug", "cmake-build-release"] as const;

/** Mirrors clangd's lookup: ancestors of the project and their build directories. */
function compilationDatabase(projectRoot: string, workspaceRoot: string | undefined): string | undefined {
	for (const directory of ancestors(projectRoot, workspaceRoot)) {
		for (const buildDirectory of BUILD_DIRECTORIES) {
			for (const name of DATABASE_NAMES) {
				const path = join(directory, buildDirectory, name);
				if (existsSync(path)) return path;
			}
		}
	}
	return undefined;
}

export const resolveCpp: ToolchainAdapter = async ({ environment, projectRoot, workspaceRoot, signal }) => {
	const env = environment.variables;
	const database = compilationDatabase(projectRoot, workspaceRoot);
	const facts: Record<string, string | null> = {
		compilationDatabase: database ?? null,
		compilationDatabaseModified: database ? String(statSync(database).mtimeMs) : null,
		CC: env["CC"] ?? null,
		CXX: env["CXX"] ?? null,
		SDKROOT: env["SDKROOT"] ?? null,
		CPATH: env["CPATH"] ?? null,
		ccVersion: null,
		cxxVersion: null,
	};
	for (const [variable, factKey] of [
		["CC", "ccVersion"],
		["CXX", "cxxVersion"],
	] as const) {
		const compiler = env[variable];
		const executable = compiler ? findExecutable(compiler, env, workspaceRoot) : undefined;
		if (executable === undefined) continue;
		const result = await runProbe(executable, ["--version"], { env, ...(signal ? { signal } : {}) });
		facts[factKey] = result.exitCode === 0 ? firstLine(result.stdout) : null;
	}
	const notes =
		database === undefined
			? ["No compile_commands.json or compile_flags.txt was found; clangd falls back to default flags."]
			: [];
	return {
		kind: "cpp",
		status: "resolved",
		source: sourceLabel(database ? "compilation database" : "default flags", environment),
		summary: database ? `compilation database ${database}` : "no compilation database",
		facts,
		notes,
		fingerprint: stableHash(facts),
	};
};
