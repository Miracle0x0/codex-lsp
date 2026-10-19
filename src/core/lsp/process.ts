import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { reportBestEffortCleanupError } from "./cleanup-errors.js";
import { envValue } from "./command.js";
import { STOP_KILL_TIMEOUT_MS, STOP_TERM_TIMEOUT_MS } from "./constants.js";
import { LspInvalidPathError, LspProcessSpawnError } from "./errors.js";

export interface SpawnedProcess {
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	pid: number | undefined;
	exitCode: number | null;
	exited: Promise<number>;
	/** Stops the owned process group, even after its leader exits. Repeated calls share completion. */
	terminate(): Promise<void>;
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

function hasErrorCode(error: unknown, code: string | number): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === code;
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
	let termination: Promise<void> | undefined;
	const terminate = (): Promise<void> => {
		termination ??= terminateProcessTree(proc);
		return termination;
	};
	const exitedPromise = new Promise<number>((resolve) => {
		// A descendant may retain stdio after the leader dies; close is not a process-exit notification.
		proc.once("exit", (code) => {
			// Release group ownership now, not at a later idle reap when this PID could have been reused.
			void terminate().catch((error: unknown) => reportBestEffortCleanupError("process group cleanup", error));
			resolve(code ?? 0);
		});
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
		terminate,
	};
}

/** Darwin also returns EPERM for groups containing only zombies; verify members before accepting it. */
async function signalGroup(pid: number, signal: NodeJS.Signals | 0): Promise<boolean> {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ESRCH")) return false;
		if (process.platform === "darwin" && hasErrorCode(error, "EPERM")) {
			const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pgid=,stat="], {
				timeout: STOP_KILL_TIMEOUT_MS,
			});
			const hasLiveMember = stdout.split("\n").some((line) => {
				const [group, state] = line.trim().split(/\s+/);
				return Number(group) === pid && !state?.startsWith("Z");
			});
			if (!hasLiveMember) return false;
		}
		throw error;
	}
}

async function waitForExit(alive: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (await alive()) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await delay(Math.min(20, remaining));
	}
	return true;
}

async function terminateProcessTree(proc: ChildProcess): Promise<void> {
	const pid = proc.pid;
	if (pid === undefined) return;
	try {
		if (process.platform === "win32") {
			if (proc.exitCode !== null || proc.signalCode !== null) return;
			try {
				await promisify(execFile)("taskkill", ["/pid", String(pid), "/f", "/t"], {
					windowsHide: true,
					timeout: STOP_TERM_TIMEOUT_MS,
					killSignal: "SIGKILL",
				});
			} catch (error) {
				// taskkill can lose the race before Node observes the child's exit event.
				if (!hasErrorCode(error, 128)) throw error;
				try {
					process.kill(pid, 0);
				} catch (probeError) {
					if (hasErrorCode(probeError, "ESRCH")) return;
					throw probeError;
				}
				throw error;
			}
			if (!(await waitForExit(() => proc.exitCode === null && proc.signalCode === null, STOP_KILL_TIMEOUT_MS))) {
				throw new Error(`Language server process ${pid} is still running after taskkill`);
			}
			return;
		}
		if (!(await signalGroup(pid, "SIGTERM"))) return;
		if (await waitForExit(() => signalGroup(pid, 0), STOP_TERM_TIMEOUT_MS)) return;
		await signalGroup(pid, "SIGKILL");
		if (!(await waitForExit(() => signalGroup(pid, 0), STOP_KILL_TIMEOUT_MS))) {
			throw new Error(`Language server process group ${pid} is still present after SIGKILL`);
		}
	} finally {
		proc.stdin?.destroy();
		proc.stdout?.destroy();
		proc.stderr?.destroy();
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
