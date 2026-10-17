import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSpawnCommand, spawnProcess } from "../../src/core/lsp/process.js";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";

		const cleanup = () => {
			stream.off("data", onData);
			stream.off("error", onError);
		};

		const onData = (chunk: Buffer | string) => {
			buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			cleanup();
			resolve(buffer.slice(0, newlineIndex).trim());
		};

		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};

		stream.on("data", onData);
		stream.on("error", onError);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killPidBestEffort(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already exited.
	}
}

describe("createSpawnCommand", () => {
	it("#given a resolved windows executable #when building the spawn command #then it starts directly without a shell", () => {
		// when
		const prepared = createSpawnCommand(["C:\\bin\\gopls.exe", "serve"], {}, "win32");

		// then
		expect(prepared).toEqual({ command: "C:\\bin\\gopls.exe", args: ["serve"], shell: false });
	});

	it("#given a resolved windows cmd shim #when building the spawn command #then the child environment's command processor runs it", () => {
		// when
		const prepared = createSpawnCommand(
			["C:\\npm\\typescript-language-server.cmd", "--stdio"],
			{ COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
			"win32",
		);

		// then
		expect(prepared).toEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", "C:\\npm\\typescript-language-server.cmd", "--stdio"],
			shell: false,
		});
	});

	it("#given a cmd shim without ComSpec in the child environment #when building the spawn command #then cmd.exe is used", () => {
		// when
		const prepared = createSpawnCommand(["C:\\npm\\pyright.bat"], {}, "win32");

		// then
		expect(prepared.command).toBe("cmd.exe");
	});

	it("#given a posix command named like a shim #when building the spawn command #then it is not wrapped", () => {
		// when
		const prepared = createSpawnCommand(["/opt/tools/run.cmd", "-x"], { ComSpec: "cmd.exe" }, "linux");

		// then
		expect(prepared).toEqual({ command: "/opt/tools/run.cmd", args: ["-x"], shell: false });
	});
});

describe("spawnProcess", () => {
	it.skipIf(process.platform === "win32")(
		"#given child process tree #when killing spawned wrapper #then descendant process exits too",
		async () => {
			// given
			const directory = mkdtempSync(join(tmpdir(), "lsp-tools-process-tree-"));
			tempDirectories.push(directory);
			const script = [
				"const { spawn } = require('node:child_process')",
				"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
				"console.error(String(child.pid))",
				"process.on('SIGTERM', () => process.exit(0))",
				"setInterval(() => {}, 1000)",
			].join(";");
			const proc = spawnProcess([process.execPath, "-e", script], { cwd: directory, env: process.env });
			const childPid = Number(await readFirstLine(proc.stderr));

			try {
				// when
				proc.kill("SIGTERM");
				await Promise.race([proc.exited, sleep(2_000)]);
				await sleep(200);

				// then
				expect(Number.isInteger(childPid)).toBe(true);
				expect(isPidAlive(childPid)).toBe(false);
			} finally {
				killPidBestEffort(childPid);
				proc.kill("SIGKILL");
			}
		},
	);
});
