import { basename } from "node:path";

import {
	type CaptureResult,
	ENVIRONMENT_ID_PATTERN,
	loadEffectiveConfig,
	newEnvironmentId,
	writeSnapshot,
} from "@code-yeongyu/lsp-tools-mcp";

import { CONTEXT_ID_ENV } from "./binding.js";

export type CaptureKind = "launch" | "shell" | "command";

export interface CaptureOptions {
	readonly kind: CaptureKind;
	readonly stateDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** The shell (or launcher parent) whose environment this is. */
	readonly shellPid: number;
	/** Shell name; defaults to the basename of $SHELL. */
	readonly shellName?: string;
}

export class CaptureError extends Error {
	override readonly name = "CaptureError";
}

/** The calling shell's own environment id, when shell integration exported a valid one. */
export function shellEnvironmentId(env: NodeJS.ProcessEnv): string | undefined {
	const id = env[CONTEXT_ID_ENV];
	return id !== undefined && ENVIRONMENT_ID_PATTERN.test(id) ? id : undefined;
}

/** Invalid configuration must fail capture, including from a prompt hook. */
function extraVariables(cwd: string): readonly string[] {
	return loadEffectiveConfig(cwd).environment.extraVariables;
}

/**
 * Writes a snapshot of `env`. A shell capture updates the shell's own id (a new generation only when
 * variables changed); launch and command captures get a fresh id whose parent is the shell's id.
 */
export function captureEnvironment(options: CaptureOptions): CaptureResult {
	const shellId = shellEnvironmentId(options.env);
	if (options.kind === "shell" && shellId === undefined) {
		throw new CaptureError(
			`${CONTEXT_ID_ENV} is not set to a valid id; run the output of 'codex-lsp env shell-init'`,
		);
	}
	const environmentId = options.kind === "shell" && shellId !== undefined ? shellId : newEnvironmentId();
	const shellName = options.shellName ?? basename(options.env["SHELL"] ?? "shell");
	return writeSnapshot(options.stateDir, {
		environmentId,
		kind: options.kind,
		executionContextId: `${options.kind}:${options.shellPid}`,
		...(options.kind !== "shell" && shellId !== undefined ? { parentEnvironmentId: shellId } : {}),
		cwd: options.cwd,
		shell: { name: shellName, pid: options.shellPid },
		env: options.env,
		extraVariables: extraVariables(options.cwd),
	});
}
