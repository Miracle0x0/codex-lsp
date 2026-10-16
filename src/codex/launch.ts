import { spawn } from "node:child_process";

import { CONTEXT_ID_ENV, MANIFEST_ENV } from "./environment/binding.js";
import { captureEnvironment } from "./environment/capture.js";

export interface LaunchOptions {
	readonly codexArgs: readonly string[];
	readonly stateDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** Executable to start; `codex` on PATH by default. */
	readonly codex?: string;
}

/**
 * Captures this shell's environment as a launch snapshot and starts Codex with it bound. `--no-daemon`
 * makes Codex run its own app server, so the plugin's MCP process inherits this binding instead of a
 * shared daemon's environment. Resolves with the exit code Codex ended with.
 */
export async function launch(options: LaunchOptions): Promise<number> {
	const captured = captureEnvironment({
		kind: "launch",
		stateDir: options.stateDir,
		env: options.env,
		cwd: options.cwd,
		shellPid: process.ppid,
	});
	const args = options.codexArgs.includes("--no-daemon")
		? [...options.codexArgs]
		: ["--no-daemon", ...options.codexArgs];
	const child = spawn(options.codex ?? "codex", args, {
		stdio: "inherit",
		env: {
			...options.env,
			[CONTEXT_ID_ENV]: captured.snapshot.environmentId,
			[MANIFEST_ENV]: captured.manifestPath,
		},
	});
	// The terminal delivers Ctrl-C to Codex itself; the launcher only waits for it.
	const ignore = (): void => undefined;
	process.on("SIGINT", ignore);
	try {
		return await new Promise<number>((resolve, reject) => {
			child.once("error", (error) =>
				reject(new Error(`cannot start ${options.codex ?? "codex"}: ${error.message}`)),
			);
			child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128 + signalNumber(signal))));
		});
	} finally {
		process.off("SIGINT", ignore);
	}
}

function signalNumber(signal: NodeJS.Signals): number {
	const numbers: Partial<Record<NodeJS.Signals, number>> = {
		SIGHUP: 1,
		SIGINT: 2,
		SIGQUIT: 3,
		SIGKILL: 9,
		SIGTERM: 15,
	};
	return numbers[signal] ?? 1;
}
