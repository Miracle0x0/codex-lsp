import { isAbsolute, normalize, resolve } from "node:path";

import { ToolFailure } from "../tools/failures.js";

/** Per-call context the host supplies alongside tool arguments. */
export interface ToolCallContext {
	readonly signal: AbortSignal;
	/** Workspace root reported by the host for this call (absolute). */
	readonly workspaceRoot?: string;
	readonly environmentId?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
}

export type HostCallContext = Omit<ToolCallContext, "signal">;

/**
 * Maps the request `_meta` of a tool call to host context. Hosts with their own
 * metadata conventions (for example Codex turn metadata) provide one.
 */
export type ContextResolver = (meta: Readonly<Record<string, unknown>> | undefined) => HostCallContext;

export interface WorkspaceInput {
	readonly workspaceRoot?: string | undefined;
}

export function resolveWorkspaceRoot(
	input: WorkspaceInput,
	context: ToolCallContext,
	defaultWorkspaceRoot: string | undefined,
): string | undefined {
	const candidate = input.workspaceRoot ?? context.workspaceRoot ?? defaultWorkspaceRoot;
	if (candidate === undefined) return undefined;
	if (!isAbsolute(candidate)) {
		throw new ToolFailure("invalid_path", `workspaceRoot must be an absolute path: ${candidate}`);
	}
	return normalize(candidate);
}

/** Resolves a tool path argument against the workspace root; never against the server process cwd. */
export function resolveToolPath(path: string, workspaceRoot: string | undefined): string {
	if (isAbsolute(path)) return normalize(path);
	if (workspaceRoot === undefined) {
		throw new ToolFailure(
			"invalid_path",
			`Relative path '${path}' needs a workspace root; pass an absolute path or workspaceRoot.`,
		);
	}
	return resolve(workspaceRoot, path);
}
