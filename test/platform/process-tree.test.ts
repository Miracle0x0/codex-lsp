import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { spawnProcess } from "../../src/core/lsp/process.js";

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const onData = (chunk: Buffer | string): void => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			stream.off("data", onData);
			resolve(buffer.slice(0, newline).trim());
		};
		stream.on("data", onData);
		stream.once("error", reject);
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Polls an observable condition until it holds; failing after the deadline instead of sleeping a fixed time. */
async function eventually(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// Process groups and POSIX signals; Windows uses taskkill /t, which this case does not cover.
describe.skipIf(process.platform === "win32")("spawnProcess process tree (POSIX)", () => {
	it("#given a child process tree #when killing the spawned wrapper #then the descendant exits too", async () => {
		// given
		const directory = mkdtempSync(join(tmpdir(), "lsp-tools-process-tree-"));
		const script = [
			"const { spawn } = require('node:child_process')",
			"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
			"console.error(String(child.pid))",
			"process.on('SIGTERM', () => process.exit(0))",
			"setInterval(() => {}, 1000)",
		].join(";");
		const proc = spawnProcess([process.execPath, "-e", script], { cwd: directory, env: process.env });
		const childPid = Number(await firstLine(proc.stderr));

		try {
			// when
			await proc.terminate();
			await proc.exited;

			// then
			expect(Number.isInteger(childPid)).toBe(true);
			await eventually(() => !alive(childPid), 5_000);
		} finally {
			if (alive(childPid)) process.kill(childPid, "SIGKILL");
			await proc.terminate();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
