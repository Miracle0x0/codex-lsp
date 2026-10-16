import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stableHash } from "../../config/loader.js";
import { findExecutable } from "../../lsp/command.js";
import { probeFailure, runProbe } from "../probe.js";
import { ancestors, firstLine, sourceLabel, type ToolchainAdapter, unavailableToolchain } from "./types.js";

interface TypeScriptSdk {
	readonly path: string;
	readonly version: string;
}

function findTypeScriptSdk(projectRoot: string, workspaceRoot: string | undefined): TypeScriptSdk | undefined {
	for (const directory of ancestors(projectRoot, workspaceRoot)) {
		const packageDir = join(directory, "node_modules", "typescript");
		try {
			const raw: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
			if (typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string") {
				return { path: packageDir, version: raw.version };
			}
		} catch {}
	}
	return undefined;
}

export const resolveNode: ToolchainAdapter = async ({ environment, projectRoot, workspaceRoot, signal }) => {
	const env = environment.variables;
	const source = sourceLabel("shell PATH", environment);
	const node = findExecutable("node", env);
	const sdk = findTypeScriptSdk(projectRoot, workspaceRoot);
	const facts: Record<string, string | null> = {
		node: node ?? null,
		nodeVersion: null,
		typescriptSdk: sdk?.path ?? null,
		typescriptVersion: sdk?.version ?? null,
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
		sdk === undefined ? [`No project TypeScript SDK (node_modules/typescript) was found from ${projectRoot}.`] : [];
	return {
		kind: "node",
		status: "resolved",
		source,
		summary: `Node ${facts["nodeVersion"]} at ${node}; TypeScript ${sdk ? `${sdk.version} at ${sdk.path}` : "not installed in the project"}`,
		facts,
		notes,
		fingerprint: stableHash(facts),
	};
};
