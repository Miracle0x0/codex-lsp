import { ToolFailure } from "../tools/failures.js";
import {
	type EnvironmentSnapshot,
	EnvironmentStoreError,
	readManifest,
	readSnapshot,
	type SnapshotKind,
} from "./snapshot.js";

export type EnvironmentSourceKind = "shell-snapshot" | "process" | "unbound";

/** The environment one tool call runs language servers and probes in. */
export interface EnvironmentContext {
	readonly environmentId: string | null;
	readonly generation: number | null;
	readonly kind: SnapshotKind | null;
	readonly source: EnvironmentSourceKind;
	readonly capturedAt: string | null;
	readonly snapshotCwd: string | null;
	/** Effective variables for child processes. */
	readonly variables: Readonly<Record<string, string>>;
	readonly notes: readonly string[];
	/** Identity of this environment generation; changes whenever the variables may have changed. */
	readonly key: string;
}

export const UNBOUND_NOTE =
	"No shell environment is bound to this call; language servers use the MCP server process environment.";

function processVariables(env: NodeJS.ProcessEnv): Record<string, string> {
	const variables: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) variables[name] = value;
	}
	return variables;
}

function deleteVariable(variables: Record<string, string>, name: string): void {
	if (process.platform !== "win32") {
		delete variables[name];
		return;
	}
	const lower = name.toLowerCase();
	for (const key of Object.keys(variables)) {
		if (key.toLowerCase() === lower) delete variables[key];
	}
}

/** Applies a snapshot on top of the process environment, propagating unset variables. */
export function applySnapshot(
	base: Readonly<Record<string, string>>,
	snapshot: EnvironmentSnapshot,
): Record<string, string> {
	const variables = { ...base };
	for (const name of snapshot.removed) deleteVariable(variables, name);
	for (const [name, value] of Object.entries(snapshot.variables)) {
		deleteVariable(variables, name);
		variables[name] = value;
	}
	return variables;
}

export interface EnvironmentServiceOptions {
	readonly stateDir?: string;
	readonly processEnv?: NodeJS.ProcessEnv;
}

export class EnvironmentService {
	readonly stateDir: string | undefined;
	private readonly processEnv: NodeJS.ProcessEnv;

	constructor(options: EnvironmentServiceOptions = {}) {
		this.stateDir = options.stateDir;
		this.processEnv = options.processEnv ?? process.env;
	}

	resolve(environmentId: string | undefined, mode: "active-shell" | "process"): EnvironmentContext {
		const base = processVariables(this.processEnv);
		if (mode === "process") {
			return {
				environmentId: null,
				generation: null,
				kind: null,
				source: "process",
				capturedAt: null,
				snapshotCwd: null,
				variables: base,
				notes: [],
				key: "process",
			};
		}
		if (environmentId === undefined) {
			return {
				environmentId: null,
				generation: null,
				kind: null,
				source: "unbound",
				capturedAt: null,
				snapshotCwd: null,
				variables: base,
				notes: [UNBOUND_NOTE],
				key: "unbound",
			};
		}
		const snapshot = this.readSnapshot(environmentId);
		return {
			environmentId,
			generation: snapshot.generation,
			kind: snapshot.kind,
			source: "shell-snapshot",
			capturedAt: snapshot.capturedAt,
			snapshotCwd: snapshot.cwd,
			variables: applySnapshot(base, snapshot),
			notes: [],
			key: `${environmentId}#${snapshot.generation}`,
		};
	}

	private readSnapshot(environmentId: string): EnvironmentSnapshot {
		if (this.stateDir === undefined) {
			throw new ToolFailure(
				"environment_error",
				`Environment ${environmentId} was requested but no environment state directory is configured.`,
			);
		}
		try {
			const manifest = readManifest(this.stateDir, environmentId);
			if (manifest === undefined) {
				throw new ToolFailure(
					"environment_error",
					`Environment ${environmentId} has no captured snapshot in ${this.stateDir}; capture it from the shell first.`,
				);
			}
			return readSnapshot(this.stateDir, manifest);
		} catch (error) {
			if (error instanceof EnvironmentStoreError) throw new ToolFailure("environment_error", error.message);
			throw error;
		}
	}
}
