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
	readonly fingerprint: string;
}

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
