import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSpawnCommand } from "../lsp/process.js";

export interface ProbeResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error: string | undefined;
	readonly timedOut: boolean;
}

export interface ProbeOptions {
	readonly env: Readonly<Record<string, string>>;
	/** Defaults to an empty private directory so probes never import modules planted in a project. */
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
let neutralDirectory: string | undefined;

function neutralCwd(): string {
	if (neutralDirectory === undefined) {
		const directory = mkdtempSync(join(tmpdir(), "lsp-tools-probe-"));
		process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
		neutralDirectory = directory;
	}
	return neutralDirectory;
}

/** Runs a short-lived toolchain query without a shell and with a hard timeout. */
export function runProbe(executable: string, args: readonly string[], options: ProbeOptions): Promise<ProbeResult> {
	return new Promise((resolve) => {
		const prepared = createSpawnCommand([executable, ...args], process.platform, options.env["ComSpec"], options.env);
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const child = spawn(prepared.command, prepared.args, {
			cwd: options.cwd ?? neutralCwd(),
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
		const finish = (result: Omit<ProbeResult, "stdout" | "stderr" | "timedOut">): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ ...result, stdout, stderr, timedOut });
		};
		const onAbort = (): void => {
			child.kill("SIGKILL");
			finish({ exitCode: null, error: "probe cancelled" });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			finish({ exitCode: null, error: `timed out after ${options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS}ms` });
		}, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
		});
		child.on("error", (error) => finish({ exitCode: null, error: error.message }));
		child.on("close", (code) => finish({ exitCode: code, error: undefined }));
	});
}

export function probeFailure(executable: string, result: ProbeResult): string {
	const detail = result.error ?? (result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`);
	return `${executable} failed: ${detail.split("\n").slice(0, 5).join("\n")}`;
}
