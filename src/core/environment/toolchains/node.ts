import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import * as z from "zod";

import { stableHash } from "../../config/loader.js";
import { findExecutable } from "../../lsp/command.js";
import { probeFailure, runProbe } from "../probe.js";
import {
	ancestors,
	fileStamp,
	firstLine,
	sourceLabel,
	type ToolchainAdapter,
	type ToolchainInputFile,
	type TypeScriptSdk,
	unavailableToolchain,
} from "./types.js";

const ManifestSchema = z.object({
	name: z.string().optional(),
	version: z.string(),
	bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

/** Automatic selection covers majors below this through tsserver and exactly this one natively. */
const NATIVE_MAJOR = 7;

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Reads one installed package and decides which backend its layout supports. */
function readSdk(path: string, inputs: ToolchainInputFile[]): TypeScriptSdk {
	const manifestPath = join(path, "package.json");
	inputs.push({ path: manifestPath, stamp: fileStamp(manifestPath) });
	const invalid = (version: string | null, problem: string): TypeScriptSdk => ({
		status: "invalid",
		path,
		version,
		problem,
	});
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return invalid(null, `cannot read ${manifestPath}: ${errorText(error)}`);
	}
	const parsed = ManifestSchema.safeParse(raw);
	if (!parsed.success) return invalid(null, `${manifestPath} has no valid version`);
	const { name, version, bin } = parsed.data;
	if (name !== "typescript") {
		return invalid(version, `the installed package is '${name ?? "(unnamed)"}', not 'typescript'`);
	}
	const major = /^(\d+)\./.exec(version)?.[1];
	const entryAt = (entry: string): string | undefined => {
		inputs.push({ path: entry, stamp: fileStamp(entry) });
		return isFile(entry) ? entry : undefined;
	};
	if (major !== undefined && Number(major) < NATIVE_MAJOR) {
		const tsserver = join(path, "lib", "tsserver.js");
		if (entryAt(tsserver) === undefined) return invalid(version, `TypeScript ${version} has no ${tsserver}`);
		return { status: "ready", path, version, backend: "typescript-language-server", entry: tsserver };
	}
	if (major !== undefined && Number(major) === NATIVE_MAJOR) {
		const tsc = typeof bin === "object" ? bin["tsc"] : undefined;
		if (tsc === undefined) return invalid(version, `${manifestPath} declares no bin.tsc entry`);
		const entry = resolve(path, tsc);
		if (entryAt(entry) === undefined) return invalid(version, `the bin.tsc entry ${entry} is missing`);
		return { status: "ready", path, version, backend: "typescript-native", entry };
	}
	return invalid(
		version,
		`TypeScript ${version} is not supported by automatic backend selection ` +
			`(supported: versions below ${NATIVE_MAJOR} with lib/tsserver.js, and ${NATIVE_MAJOR}.x native LSP)`,
	);
}

/** The nearest `node_modules/typescript` from the project root up to the workspace root. */
function findTypeScriptSdk(
	projectRoot: string,
	workspaceRoot: string | undefined,
	inputs: ToolchainInputFile[],
): TypeScriptSdk {
	const searched: string[] = [];
	for (const directory of ancestors(projectRoot, workspaceRoot)) {
		const path = join(directory, "node_modules", "typescript");
		const stamp = fileStamp(path);
		inputs.push({ path, stamp });
		searched.push(path);
		if (stamp !== "missing") return readSdk(path, inputs);
	}
	return { status: "missing", searched };
}

function describeSdk(sdk: TypeScriptSdk): string {
	if (sdk.status === "missing") return "not installed in the project";
	if (sdk.status === "invalid") return `unusable at ${sdk.path}`;
	return `${sdk.version} at ${sdk.path}`;
}

export const resolveNode: ToolchainAdapter = async ({ environment, projectRoot, workspaceRoot, signal }) => {
	const env = environment.variables;
	const source = sourceLabel("shell PATH", environment);
	const node = findExecutable("node", env);
	const inputs: ToolchainInputFile[] = [];
	const sdk = findTypeScriptSdk(projectRoot, workspaceRoot, inputs);
	const facts: Record<string, string | null> = {
		node: node ?? null,
		nodeVersion: null,
		typescriptSdk: sdk.status === "missing" ? null : sdk.path,
		typescriptVersion: sdk.status === "missing" ? null : sdk.version,
		typescriptBackend: sdk.status === "ready" ? sdk.backend : null,
		typescriptEntry: sdk.status === "ready" ? sdk.entry : null,
		typescriptProblem: sdk.status === "invalid" ? sdk.problem : null,
		nodeOptions: env["NODE_OPTIONS"] ?? null,
	};
	if (node === undefined) {
		return unavailableToolchain("node", source, "No node executable is on the PATH of this environment.", facts);
	}
	const result = await runProbe(node, ["--version"], { env, ...(signal ? { signal } : {}) });
	if (result.exitCode !== 0) {
		return unavailableToolchain("node", source, probeFailure(node, result), facts);
	}
	facts["nodeVersion"] = firstLine(result.stdout);
	const notes =
		sdk.status === "missing"
			? [`No project TypeScript SDK (node_modules/typescript) was found from ${projectRoot}.`]
			: sdk.status === "invalid"
				? [`The project TypeScript SDK is unusable: ${sdk.problem}`]
				: [];
	return {
		kind: "node",
		status: "resolved",
		source,
		summary: `Node ${facts["nodeVersion"]} at ${node}; TypeScript ${describeSdk(sdk)}`,
		facts,
		notes,
		typescript: sdk,
		inputs,
		fingerprint: stableHash(facts),
	};
};
