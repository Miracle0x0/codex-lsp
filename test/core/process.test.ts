import { describe, expect, it } from "vitest";

import { createSpawnCommand } from "../../src/core/lsp/process.js";

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
