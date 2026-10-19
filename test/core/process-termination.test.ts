import { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnProcess } from "../../src/core/lsp/process.js";

const native = vi.hoisted(() => ({
	spawn: vi.fn(),
	execute: vi.fn<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	const { promisify } = await import("node:util");
	return {
		...original,
		spawn: native.spawn,
		execFile: Object.assign(vi.fn(), { [promisify.custom]: native.execute }),
	};
});

const originalPlatform = process.platform;
const pid = 42;
const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
const missing = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });

function processFor(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform });
	const child = new ChildProcess();
	Object.defineProperty(child, "pid", { value: pid });
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	native.spawn.mockReturnValue(child);
	const processHandle = spawnProcess(["language-server"], { cwd: tmpdir(), env: {} });
	return { child, processHandle };
}

beforeEach(() => {
	native.spawn.mockReset();
	native.execute.mockReset();
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	vi.restoreAllMocks();
});

describe("platform process termination races", () => {
	it.each(["42 Z\n", "43 S\n"])(
		"#given Darwin reports EPERM for an exited group (%s) #when stopping #then cleanup succeeds",
		async (stdout) => {
			const { processHandle } = processFor("darwin");
			vi.spyOn(process, "kill").mockImplementation(() => {
				throw denied;
			});
			native.execute.mockResolvedValue({ stdout, stderr: "" });
			await expect(processHandle.terminate()).resolves.toBeUndefined();
		},
	);

	it("#given Darwin has a live worker in the denied group #when stopping #then the permission failure is reported", async () => {
		const { child, processHandle } = processFor("darwin");
		Object.defineProperty(child, "exitCode", { value: 0 });
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw denied;
		});
		native.execute.mockResolvedValue({ stdout: "42 Z\n42 S\n", stderr: "" });
		await expect(processHandle.terminate()).rejects.toBe(denied);
	});

	it("#given Linux denies a group signal #when stopping #then EPERM is not treated as an exited group", async () => {
		const { processHandle } = processFor("linux");
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw denied;
		});
		await expect(processHandle.terminate()).rejects.toBe(denied);
		expect(native.execute).not.toHaveBeenCalled();
	});

	it("#given Darwin denies a signal and the process query fails #when stopping #then the query failure is exposed", async () => {
		const { processHandle } = processFor("darwin");
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw denied;
		});
		const queryError = new Error("cannot read process table");
		native.execute.mockRejectedValue(queryError);
		await expect(processHandle.terminate()).rejects.toBe(queryError);
	});

	it("#given taskkill races with natural exit #when the PID is confirmed absent #then cleanup succeeds", async () => {
		const { processHandle } = processFor("win32");
		native.execute.mockRejectedValue(Object.assign(new Error("taskkill: process not found"), { code: 128 }));
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw missing;
		});
		await expect(processHandle.terminate()).resolves.toBeUndefined();
		expect(kill).toHaveBeenCalledWith(pid, 0);
	});

	it("#given taskkill fails but its target still exists #when stopping #then its error is preserved", async () => {
		const { processHandle } = processFor("win32");
		const error = Object.assign(new Error("taskkill failed"), { code: 128 });
		native.execute.mockRejectedValue(error);
		vi.spyOn(process, "kill").mockReturnValue(true);
		await expect(processHandle.terminate()).rejects.toBe(error);
	});

	it("#given taskkill cannot find a target but probing is denied #when stopping #then the permission failure is reported", async () => {
		const { processHandle } = processFor("win32");
		native.execute.mockRejectedValue(Object.assign(new Error("taskkill failed"), { code: 128 }));
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw denied;
		});
		await expect(processHandle.terminate()).rejects.toBe(denied);
	});

	it.each([5, "ENOENT"])(
		"#given taskkill fails with %s #when stopping #then the failure is not hidden by a missing PID",
		async (code) => {
			const { processHandle } = processFor("win32");
			const error = Object.assign(new Error("taskkill failed"), { code });
			native.execute.mockRejectedValue(error);
			const kill = vi.spyOn(process, "kill").mockImplementation(() => {
				throw missing;
			});
			await expect(processHandle.terminate()).rejects.toBe(error);
			expect(kill).not.toHaveBeenCalled();
		},
	);
});
