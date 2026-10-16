import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import * as z from "zod";

import { snapshotVariableNames } from "./variables.js";

/** Older generations kept on disk so readers holding a previous manifest can still load it. */
const RETAINED_GENERATIONS = 3;

export const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/;

export const EnvironmentIdSchema = z
	.string()
	.regex(ENVIRONMENT_ID_PATTERN, "environment ids are 8-128 characters of letters, digits, '.', '_' or '-'");

export const SnapshotKindSchema = z.enum(["launch", "shell", "command"]);
export type SnapshotKind = z.infer<typeof SnapshotKindSchema>;

export const EnvironmentSnapshotSchema = z.strictObject({
	schemaVersion: z.literal(1),
	environmentId: EnvironmentIdSchema,
	generation: z.number().int().min(1),
	kind: SnapshotKindSchema,
	executionContextId: z.string().min(1),
	parentEnvironmentId: EnvironmentIdSchema.optional(),
	capturedAt: z.string().min(1),
	cwd: z.string().min(1),
	shell: z.strictObject({ name: z.string().min(1), pid: z.number().int() }).optional(),
	variables: z.record(z.string(), z.string()),
	removed: z.array(z.string()),
});
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshotSchema>;

const ManifestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	environmentId: EnvironmentIdSchema,
	kind: SnapshotKindSchema,
	parentEnvironmentId: EnvironmentIdSchema.optional(),
	generation: z.number().int().min(1),
	snapshot: z.string().regex(/^gen-\d+\.json$/),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
});
export type EnvironmentManifest = z.infer<typeof ManifestSchema>;

export class EnvironmentStoreError extends Error {
	override readonly name = "EnvironmentStoreError";
}

/** Directory holding environment snapshots: explicit option > env var > platform state dir. */
export function defaultStateDir(appName: string, envVar: string, env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env[envVar];
	if (explicit && isAbsolute(explicit)) return explicit;
	if (process.platform === "win32") {
		return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), appName);
	}
	const stateHome = env["XDG_STATE_HOME"];
	return join(stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), ".local", "state"), appName);
}

export function environmentDir(stateDir: string, environmentId: string): string {
	if (!ENVIRONMENT_ID_PATTERN.test(environmentId))
		throw new EnvironmentStoreError(`invalid environment id: ${environmentId}`);
	return join(stateDir, "environments", environmentId);
}

export function manifestPath(stateDir: string, environmentId: string): string {
	return join(environmentDir(stateDir, environmentId), "manifest.json");
}

function atomicWriteJson(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function readManifest(stateDir: string, environmentId: string): EnvironmentManifest | undefined {
	const path = manifestPath(stateDir, environmentId);
	let raw: unknown;
	try {
		raw = readJson(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new EnvironmentStoreError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const parsed = ManifestSchema.safeParse(raw);
	if (!parsed.success) throw new EnvironmentStoreError(`invalid manifest ${path}: ${parsed.error.message}`);
	if (parsed.data.environmentId !== environmentId) {
		throw new EnvironmentStoreError(`manifest ${path} names environment ${parsed.data.environmentId}`);
	}
	return parsed.data;
}

export function readSnapshot(stateDir: string, manifest: EnvironmentManifest): EnvironmentSnapshot {
	const path = join(environmentDir(stateDir, manifest.environmentId), manifest.snapshot);
	let raw: unknown;
	try {
		raw = readJson(path);
	} catch (error) {
		throw new EnvironmentStoreError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const parsed = EnvironmentSnapshotSchema.safeParse(raw);
	if (!parsed.success) throw new EnvironmentStoreError(`invalid snapshot ${path}: ${parsed.error.message}`);
	if (parsed.data.generation !== manifest.generation || parsed.data.environmentId !== manifest.environmentId) {
		throw new EnvironmentStoreError(`snapshot ${path} does not match its manifest`);
	}
	return parsed.data;
}

export interface CaptureInput {
	readonly environmentId: string;
	readonly kind: SnapshotKind;
	readonly executionContextId: string;
	readonly parentEnvironmentId?: string;
	readonly cwd: string;
	readonly shell?: { readonly name: string; readonly pid: number };
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly extraVariables?: readonly string[];
}

export interface CaptureResult {
	readonly snapshot: EnvironmentSnapshot;
	readonly manifestPath: string;
	/** False when the directory and variables matched the previous generation and nothing was written. */
	readonly changed: boolean;
}

/** Selects the whitelisted variables; absent ones are listed as removed so unsets propagate. */
export function selectVariables(
	env: Readonly<Record<string, string | undefined>>,
	extraVariables: readonly string[] = [],
): { variables: Record<string, string>; removed: string[] } {
	const variables: Record<string, string> = {};
	const removed: string[] = [];
	for (const name of snapshotVariableNames(extraVariables)) {
		const value = env[name];
		if (value === undefined) removed.push(name);
		else variables[name] = value;
	}
	return { variables, removed };
}

function sameVariables(a: EnvironmentSnapshot, variables: Record<string, string>, removed: readonly string[]): boolean {
	const aKeys = Object.keys(a.variables).sort();
	const bKeys = Object.keys(variables).sort();
	if (aKeys.join("\0") !== bKeys.join("\0")) return false;
	if ([...a.removed].sort().join("\0") !== [...removed].sort().join("\0")) return false;
	return aKeys.every((key) => a.variables[key] === variables[key]);
}

/** Writes a new generation when the directory or variables changed; manifests are replaced atomically. */
export function writeSnapshot(stateDir: string, input: CaptureInput): CaptureResult {
	const dir = environmentDir(stateDir, input.environmentId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const previous = readManifest(stateDir, input.environmentId);
	const { variables, removed } = selectVariables(input.env, input.extraVariables);
	const now = new Date().toISOString();
	const path = manifestPath(stateDir, input.environmentId);

	if (previous !== undefined) {
		const previousSnapshot = readSnapshot(stateDir, previous);
		if (previousSnapshot.cwd === input.cwd && sameVariables(previousSnapshot, variables, removed)) {
			return { snapshot: previousSnapshot, manifestPath: path, changed: false };
		}
	}

	const generation = (previous?.generation ?? 0) + 1;
	const snapshot: EnvironmentSnapshot = {
		schemaVersion: 1,
		environmentId: input.environmentId,
		generation,
		kind: input.kind,
		executionContextId: input.executionContextId,
		...(input.parentEnvironmentId === undefined ? {} : { parentEnvironmentId: input.parentEnvironmentId }),
		capturedAt: now,
		cwd: input.cwd,
		...(input.shell === undefined ? {} : { shell: input.shell }),
		variables,
		removed,
	};
	const snapshotName = `gen-${generation}.json`;
	atomicWriteJson(join(dir, snapshotName), snapshot);
	const manifest: EnvironmentManifest = {
		schemaVersion: 1,
		environmentId: input.environmentId,
		kind: input.kind,
		...(input.parentEnvironmentId === undefined ? {} : { parentEnvironmentId: input.parentEnvironmentId }),
		generation,
		snapshot: snapshotName,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
	};
	atomicWriteJson(path, manifest);
	if (generation > RETAINED_GENERATIONS) {
		rmSync(join(dir, `gen-${generation - RETAINED_GENERATIONS}.json`), { force: true });
	}
	return { snapshot, manifestPath: path, changed: true };
}

export function newEnvironmentId(): string {
	return `env-${randomUUID()}`;
}
