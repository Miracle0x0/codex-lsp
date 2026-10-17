import { statSync } from "node:fs";
import { dirname, parse } from "node:path";

import { type EffectiveEnvironmentConfig, stableHash } from "../../config/loader.js";
import type { ToolchainKind } from "../../config/schema.js";
import type { EnvironmentContext } from "../service.js";

export interface ToolchainInput {
	readonly environment: EnvironmentContext;
	readonly projectRoot: string;
	readonly workspaceRoot: string | undefined;
	readonly config: EffectiveEnvironmentConfig;
	readonly signal?: AbortSignal;
}

export interface ToolchainResolution {
	readonly kind: ToolchainKind;
	readonly status: "resolved" | "unavailable";
	/** Where the selection came from, for example "VIRTUAL_ENV (shell-snapshot)". */
	readonly source: string;
	readonly summary: string;
	readonly facts: Readonly<Record<string, string | null>>;
	/** Non-fatal observations such as a project environment the shell does not use. */
	readonly notes: readonly string[];
	/** Why the toolchain cannot be used; set when status is "unavailable". */
	readonly problem?: string;
	/** Server settings derived from the toolchain, merged under configured settings. */
	readonly settings?: Readonly<Record<string, unknown>>;
	/** The project's TypeScript SDK as found from the project root; set by the Node adapter. */
	readonly typescript?: TypeScriptSdk;
	/** Files the result was read from, with their state before reading; a changed stamp invalidates a cached result. */
	readonly inputs?: readonly ToolchainInputFile[];
	readonly fingerprint: string;
}

export interface ToolchainInputFile {
	readonly path: string;
	readonly stamp: string;
}

export type TypeScriptBackend = "typescript-language-server" | "typescript-native";

/** The `node_modules/typescript` package nearest to a project; a broken package is reported, never skipped. */
export type TypeScriptSdk =
	| { readonly status: "missing"; readonly searched: readonly string[] }
	| { readonly status: "invalid"; readonly path: string; readonly version: string | null; readonly problem: string }
	| {
			readonly status: "ready";
			readonly path: string;
			readonly version: string;
			readonly backend: TypeScriptBackend;
			/** `lib/tsserver.js` for the tsserver backend, the `bin.tsc` script for the native LSP. */
			readonly entry: string;
	  };

export type ToolchainAdapter = (input: ToolchainInput) => Promise<ToolchainResolution>;

/** Directories from `start` upwards, ending at `stop` (inclusive) or the filesystem root. */
export function ancestors(start: string, stop: string | undefined): string[] {
	const result: string[] = [];
	let current = start;
	const root = parse(current).root;
	while (true) {
		result.push(current);
		if (current === stop || current === root) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return result;
}

/** Identity and modification state of a path, or "missing"; follows symbolic links. */
export function fileStamp(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

export function firstLine(text: string): string {
	return text.trim().split(/\r?\n/)[0] ?? "";
}

export function sourceLabel(origin: string, environment: EnvironmentContext): string {
	return `${origin} (${environment.source})`;
}

export function unavailableToolchain(
	kind: ToolchainKind,
	source: string,
	problem: string,
	facts: Readonly<Record<string, string | null>>,
): ToolchainResolution {
	return {
		kind,
		status: "unavailable",
		source,
		summary: problem,
		facts: { ...facts },
		notes: [],
		problem,
		fingerprint: stableHash({ kind, problem, facts }),
	};
}
