import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { envValue, findExecutable, findFirstExecutable } from "../../src/core/lsp/command.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `codex-lsp-command-${name}-`));
	directories.push(root);
	return root;
}

/** Writes a program file; `executable: false` leaves it without the execute bit. */
function program(dir: string, name: string, executable = true): string {
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\n");
	chmodSync(path, executable ? 0o755 : 0o644);
	return path;
}

describe.skipIf(process.platform === "win32")("command lookup (POSIX)", () => {
	it("#given python3 first on PATH and python later #when finding the interpreter #then PATH order wins over name order", () => {
		// given
		const venv = directory("venv");
		const system = directory("system");
		const venvPython = program(venv, "python3");
		program(system, "python");

		// when
		const found = findFirstExecutable(["python", "python3"], { PATH: [venv, system].join(delimiter) });

		// then
		expect(found).toBe(venvPython);
	});

	it("#given a file without the execute bit earlier on PATH #when finding a command #then the next executable is used", () => {
		// given
		const first = directory("first");
		const second = directory("second");
		program(first, "tool", false);
		const usable = program(second, "tool");

		// when
		const found = findExecutable("tool", { PATH: [first, second].join(delimiter) });

		// then
		expect(found).toBe(usable);
	});

	it("#given a relative command with a separator #when finding it #then it resolves against the base directory only", () => {
		// given
		const workspace = directory("workspace space");
		mkdirSync(join(workspace, "bin"));
		const local = program(join(workspace, "bin"), "server");

		// when / then
		expect(findExecutable("./bin/server", { PATH: "" }, workspace)).toBe(local);
		expect(findExecutable("./bin/server", { PATH: join(workspace, "bin") })).toBeUndefined();
	});
});

describe.runIf(process.platform === "win32")("command lookup (Windows)", () => {
	it("#given an npm cmd shim on Path #when finding the bare command #then PATHEXT resolves the shim", () => {
		// given
		const bin = directory("npm bin");
		const shim = join(bin, "typescript-language-server.cmd");
		writeFileSync(shim, "@echo off\r\n");

		// when
		const found = findExecutable("typescript-language-server", { Path: bin, PATHEXT: ".EXE;.CMD" });

		// then
		expect(found?.toLowerCase()).toBe(shim.toLowerCase());
	});
});

describe("envValue", () => {
	it("#given a differently cased variable #when reading it #then only Windows matches case-insensitively", () => {
		const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };
		expect(envValue(env, "COMSPEC", "win32")).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(envValue(env, "COMSPEC", "linux")).toBeUndefined();
	});
});
