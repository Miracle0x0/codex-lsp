import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

import { reportBestEffortCleanupError } from "./cleanup-errors.js";
import { envValue } from "./command.js";
import { LspInvalidPathError, LspProcessSpawnError } from "./errors.js";

export interface SpawnedProcess {
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid: number | undefined;
	exitCode: number | null;
	exited: Promise<number>;
	kill(signal?: NodeJS.Signals): void;
}

export interface SpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
}

export interface PreparedSpawnCommand {
	command: string;
	args: string[];
	shell: false;
}

function isMissingProcessError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "ESRCH";
}

function reportKillError(context: string, error: unknown): void {
	if (!isMissingProcessError(error)) {
		reportBestEffortCleanupError(context, error);
	}
}

export function validateCwd(cwd: string): { valid: boolean; error?: string } {
	try {
		if (!existsSync(cwd)) {
			return { valid: false, error: `Working directory does not exist: ${cwd}` };
		}
		const stats = statSync(cwd);
		if (!stats.isDirectory()) {
			return { valid: false, error: `Path is not a directory: ${cwd}` };
		}
		return { valid: true };
	} catch (err) {
		return {
			valid: false,
			error: `Cannot access working directory: ${cwd} (${err instanceof Error ? err.message : String(err)})`,
		};
	}
}

function wrap(proc: ChildProcess): SpawnedProcess {
	const exitedPromise = new Promise<number>((resolve) => {
		proc.once("close", (code) => resolve(code ?? 0));
		proc.once("error", () => resolve(1));
	});

	if (!proc.stdin || !proc.stdout || !proc.stderr) {
		throw new LspProcessSpawnError("Spawned process is missing one of stdin/stdout/stderr pipes");
	}

	return {
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		get pid() {
			return proc.pid ?? undefined;
		},
		get exitCode() {
			return proc.exitCode;
		},
		exited: exitedPromise,
		kill(signal?: NodeJS.Signals) {
			killProcessTree(proc, signal ?? "SIGTERM");
		},
	};
}

function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform === "win32" && proc.pid) {
		const result = spawnSync("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" });
		if (!result.error && result.status === 0) return;
		if (result.error) reportKillError("windows process tree kill", result.error);
	}

	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch (error) {
			reportKillError("process group kill", error);
		}
	}

	try {
		proc.kill(signal);
	} catch (error) {
		reportKillError("process kill", error);
	}
}

function isWindowsShellShim(command: string): boolean {
	const lowerCommand = command.toLowerCase();
	return lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
}

/**
 * How to start an executable that `findExecutable` already resolved. Windows cannot start `.cmd`/`.bat`
 * shims directly, so they run through the command processor named by the child's own environment.
 */
export function createSpawnCommand(
	command: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform = process.platform,
): PreparedSpawnCommand {
	const [cmd, ...args] = command;
	if (!cmd) {
		throw new LspProcessSpawnError("[lsp] empty command");
	}
	if (platform !== "win32" || !isWindowsShellShim(cmd)) {
		return { command: cmd, args, shell: false };
	}
	return {
		command: envValue(env, "ComSpec", platform) ?? "cmd.exe",
		args: ["/d", "/s", "/c", cmd, ...args],
		shell: false,
	};
}

export function spawnProcess(command: string[], options: SpawnOptions): SpawnedProcess {
	const cwdValidation = validateCwd(options.cwd);
	if (!cwdValidation.valid) {
		throw new LspInvalidPathError(`[lsp] ${cwdValidation.error}`);
	}

	const preparedCommand = createSpawnCommand(command, options.env);
	const proc = spawn(preparedCommand.command, preparedCommand.args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		shell: preparedCommand.shell,
		detached: process.platform !== "win32",
	});

	return wrap(proc);
}
