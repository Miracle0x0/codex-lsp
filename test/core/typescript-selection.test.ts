import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerTarget } from "../../src/core/lsp/client.js";
import type { ToolCallContext } from "../../src/core/runtime/context.js";
import { createLspRuntime, type LspRuntime } from "../../src/core/runtime/runtime.js";
import { LSP_TOOLS } from "../../src/core/tools/index.js";
import { type IsolatedContext, isolatedContext } from "../support/context.js";

interface Scenario {
	readonly root: string;
	readonly runtime: LspRuntime;
	write(path: string, content: string): string;
	target(filePath: string, server?: string): Promise<ServerTarget>;
	status(filePath?: string): Promise<Record<string, unknown>>;
}

const contexts: IsolatedContext[] = [];
const runtimes: LspRuntime[] = [];
const context: ToolCallContext = { signal: new AbortController().signal };

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	for (const created of contexts.splice(0)) created.cleanup();
});

/** A directory with a stand-in `typescript-language-server`; the selection only checks that it is on PATH. */
function fakeAdapterBin(root: string): string {
	const bin = join(root, "adapter-bin");
	mkdirSync(bin, { recursive: true });
	const script = join(bin, "typescript-language-server");
	writeFileSync(script, "#!/bin/sh\nexit 0\n");
	chmodSync(script, 0o755);
	writeFileSync(`${script}.cmd`, "@exit /b 0\r\n");
	return bin;
}

function scenario(options: { readonly adapterOnPath?: boolean; readonly config?: unknown } = {}): Scenario {
	const created = isolatedContext("lsp-ts-select");
	contexts.push(created);
	const root = join(created.root, "workspace");
	mkdirSync(root);
	if (options.config !== undefined) {
		mkdirSync(join(root, ".codex"));
		writeFileSync(join(root, ".codex", "lsp-client.json"), JSON.stringify(options.config));
	}
	const path = [
		...(options.adapterOnPath === false ? [] : [fakeAdapterBin(created.root)]),
		dirname(process.execPath),
	].join(delimiter);
	const runtime = createLspRuntime({
		config: created.config,
		processEnv: { PATH: path, ...(process.platform === "win32" ? { PATHEXT: ".EXE;.CMD" } : {}) },
		defaultWorkspaceRoot: root,
		stateDir: created.stateDir,
	});
	runtimes.push(runtime);
	const write = (relative: string, content: string): string => {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
		return full;
	};
	return {
		root,
		runtime,
		write,
		async target(filePath, server) {
			const file = runtime.file({ filePath }, context);
			return runtime.semanticTarget(file, server, context.signal);
		},
		async status(filePath) {
			const tool = LSP_TOOLS.find((candidate) => candidate.name === "status");
			if (tool === undefined) throw new Error("status tool missing");
			const result = await tool.run(runtime, filePath === undefined ? {} : { filePath }, context);
			return result.data;
		},
	};
}

interface SdkOptions {
	readonly version: string;
	readonly name?: string;
	/** Files the package ships; defaults follow the real 6.x and 7.x layouts. */
	readonly layout?: "tsserver" | "native" | "none";
}

/** Installs a package laid out like the real SDK under `<dir>/node_modules/typescript`. */
function installSdk(s: Scenario, dir: string, options: SdkOptions): string {
	const base = join(dir, "node_modules", "typescript");
	const major = Number.parseInt(options.version, 10);
	const layout = options.layout ?? (major >= 7 ? "native" : "tsserver");
	const bin = layout === "native" ? { tsc: "./bin/tsc" } : { tsc: "./bin/tsc", tsserver: "./bin/tsserver" };
	s.write(
		join(base, "package.json"),
		JSON.stringify({ name: options.name ?? "typescript", version: options.version, bin }),
	);
	if (layout === "tsserver") s.write(join(base, "lib", "tsserver.js"), "");
	if (layout === "native") s.write(join(base, "bin", "tsc"), "#!/usr/bin/env node\n");
	return join(s.root, base);
}

function project(s: Scenario, dir = "."): void {
	s.write(join(dir, "package.json"), '{ "name": "fixture" }\n');
}

describe("built-in TypeScript backend selection", () => {
	it("#given a TypeScript 6 SDK #when resolving #then typescript-language-server is pinned to the project's tsserver", async () => {
		const s = scenario();
		project(s);
		const sdk = installSdk(s, ".", { version: "6.0.3" });
		s.write("main.ts", "export {};\n");

		const target = await s.target("main.ts");

		expect(target.launch.backend).toBe("typescript-language-server");
		expect(target.executable).toMatch(/typescript-language-server(\.cmd)?$/);
		expect(target.args).toEqual(["--stdio"]);
		expect(target.initializationOptions).toEqual({
			tsserver: { useSyntaxServer: "never", path: join(sdk, "lib", "tsserver.js") },
		});
		expect(target.launch.reason).toContain("6.0.3");
	});

	it("#given a TypeScript 5 SDK with lib/tsserver.js #when resolving #then the tsserver backend is used", async () => {
		const s = scenario();
		project(s);
		installSdk(s, ".", { version: "5.4.5" });
		s.write("main.ts", "export {};\n");

		expect((await s.target("main.ts")).launch.backend).toBe("typescript-language-server");
	});

	it("#given a TypeScript 7 SDK and no adapter on PATH #when resolving #then the SDK's native LSP runs under node", async () => {
		const s = scenario({ adapterOnPath: false });
		project(s);
		const sdk = installSdk(s, ".", { version: "7.0.2" });
		s.write("main.ts", "export {};\n");

		const target = await s.target("main.ts");

		expect(target.launch.backend).toBe("typescript-native");
		expect(target.executable).toMatch(/node(\.exe)?$/i);
		expect(target.args).toEqual([join(sdk, "bin", "tsc"), "--lsp", "--stdio"]);
		expect(target.initializationOptions).toBeUndefined();
	});

	it("#given TypeScript 6 and no adapter on PATH #when resolving #then the missing adapter is reported", async () => {
		const s = scenario({ adapterOnPath: false });
		project(s);
		installSdk(s, ".", { version: "6.0.3" });
		s.write("main.ts", "export {};\n");

		await expect(s.target("main.ts")).rejects.toMatchObject({
			code: "server_not_installed",
			message: expect.stringContaining("typescript-language-server"),
		});
	});

	it("#given no SDK #when resolving #then an environment error names where it looked", async () => {
		const s = scenario();
		project(s);
		s.write("main.ts", "export {};\n");

		await expect(s.target("main.ts")).rejects.toMatchObject({
			code: "environment_error",
			message: expect.stringContaining(join(s.root, "node_modules", "typescript")),
		});
	});

	it.each([
		[
			"an unreadable package.json",
			(s: Scenario) => s.write("app/node_modules/typescript/package.json", "{"),
			"package.json",
		],
		["no package.json", (s: Scenario) => s.write("app/node_modules/typescript/README.md", ""), "package.json"],
		[
			"a missing tsserver.js",
			(s: Scenario) => installSdk(s, "app", { version: "6.0.3", layout: "none" }),
			"tsserver.js",
		],
		[
			"a missing native entry",
			(s: Scenario) => installSdk(s, "app", { version: "7.0.2", layout: "none" }),
			"bin.tsc",
		],
		["an unsupported major version", (s: Scenario) => installSdk(s, "app", { version: "8.0.0" }), "8.0.0"],
		[
			"a different package",
			(s: Scenario) => installSdk(s, "app", { version: "7.0.2", name: "@typescript/native-preview" }),
			"@typescript/native-preview",
		],
	])(
		"#given %s next to a valid parent SDK #when resolving #then it fails without borrowing the parent",
		async (_name, install, reason) => {
			const s = scenario();
			project(s);
			installSdk(s, ".", { version: "6.0.3" });
			project(s, "app");
			install(s);
			s.write("app/main.ts", "export {};\n");

			const failure: unknown = await s.target("app/main.ts").then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(failure).toMatchObject({ code: "environment_error" });
			const message = failure instanceof Error ? failure.message : "";
			expect(message).toContain(join(s.root, "app", "node_modules", "typescript"));
			expect(message).toContain(reason);
		},
	);

	it("#given sub-projects on TypeScript 6 and 7 #when resolving each #then each gets its own backend and client slot", async () => {
		const s = scenario();
		project(s);
		project(s, "packages/old");
		project(s, "packages/new");
		installSdk(s, "packages/old", { version: "6.0.3" });
		installSdk(s, "packages/new", { version: "7.0.2" });
		s.write("packages/old/a.ts", "export {};\n");
		s.write("packages/new/b.ts", "export {};\n");

		const old = await s.target("packages/old/a.ts");
		const next = await s.target("packages/new/b.ts");

		expect(old.launch.backend).toBe("typescript-language-server");
		expect(next.launch.backend).toBe("typescript-native");
		expect(old.slot).not.toBe(next.slot);
		expect(old.key).not.toBe(next.key);
	});

	it("#given a cached TypeScript 6 choice #when the SDK is replaced by 7 #then the next resolution sees it at once", async () => {
		const s = scenario();
		project(s);
		installSdk(s, ".", { version: "6.0.3" });
		s.write("main.ts", "export {};\n");
		const before = await s.target("main.ts");

		rmSync(join(s.root, "node_modules", "typescript"), { recursive: true, force: true });
		installSdk(s, ".", { version: "7.0.2" });
		const after = await s.target("main.ts");

		expect(after.launch.backend).toBe("typescript-native");
		expect(after.slot).toBe(before.slot);
		expect(after.key).not.toBe(before.key);
	});

	it("#given no SDK at first #when one is installed #then the cached miss does not hide it", async () => {
		const s = scenario();
		project(s);
		s.write("main.ts", "export {};\n");
		await expect(s.target("main.ts")).rejects.toMatchObject({ code: "environment_error" });

		installSdk(s, ".", { version: "7.0.2" });

		expect((await s.target("main.ts")).launch.backend).toBe("typescript-native");
	});
});

describe("explicit TypeScript configuration", () => {
	it("#given a project definition named typescript #when resolving #then its own command is used unchanged", async () => {
		const s = scenario({
			config: {
				schemaVersion: 1,
				servers: { typescript: { command: [process.execPath, "custom-server.mjs", "--stdio"] } },
			},
		});
		project(s);
		installSdk(s, ".", { version: "7.0.2" });
		s.write("main.ts", "export {};\n");

		const target = await s.target("main.ts");

		expect(target.launch.backend).toBe("configured");
		expect(target.executable).toBe(process.execPath);
		expect(target.args).toEqual(["custom-server.mjs", "--stdio"]);
		expect(target.initializationOptions).toBeUndefined();
	});

	it("#given a route to a custom server #when resolving by default and by explicit built-in id #then each keeps its meaning", async () => {
		const s = scenario({
			config: {
				schemaVersion: 1,
				servers: { typescript7: { command: [process.execPath, "native.mjs"] } },
				languages: { typescript: { semanticServer: "typescript7", diagnosticServers: ["typescript7"] } },
			},
		});
		project(s);
		installSdk(s, ".", { version: "6.0.3" });
		s.write("main.ts", "export {};\n");

		const routed = await s.target("main.ts");
		const builtin = await s.target("main.ts", "typescript");

		expect(routed.launch.backend).toBe("configured");
		expect(routed.args).toEqual(["native.mjs"]);
		expect(builtin.launch.backend).toBe("typescript-language-server");
	});

	it("#given the built-in server disabled #when resolving #then no backend is selected", async () => {
		const s = scenario({ config: { schemaVersion: 1, servers: { typescript: { disabled: true } } } });
		project(s);
		installSdk(s, ".", { version: "7.0.2" });
		s.write("main.ts", "export {};\n");

		await expect(s.target("main.ts")).rejects.toMatchObject({ code: "server_not_configured" });
	});
});

describe("status for the selected TypeScript backend", () => {
	it("#given a TypeScript 7 file #when reading status #then the chosen backend, command, and reason are shown without a client", async () => {
		const s = scenario({ adapterOnPath: false });
		project(s);
		const sdk = installSdk(s, ".", { version: "7.0.2" });
		s.write("main.ts", "export {};\n");

		const data = await s.status("main.ts");

		expect(data).toMatchObject({
			file: {
				servers: [
					{
						serverId: "typescript",
						projectRoot: s.root,
						backend: "typescript-native",
						command: [expect.stringMatching(/node(\.exe)?$/i), join(sdk, "bin", "tsc"), "--lsp", "--stdio"],
						reason: expect.stringContaining("7.0.2"),
						problem: null,
					},
				],
			},
			clients: [],
		});
		expect(data["servers"]).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "typescript", state: "sdk-selected" })]),
		);
	});

	it("#given a broken SDK #when reading status #then the problem is shown up front", async () => {
		const s = scenario();
		project(s);
		s.write("node_modules/typescript/package.json", "{");
		s.write("main.ts", "export {};\n");

		const data = await s.status("main.ts");

		expect(data).toMatchObject({
			file: {
				servers: [
					{
						serverId: "typescript",
						backend: null,
						command: null,
						problem: expect.stringMatching(/^\[environment_error\][\s\S]*package\.json/),
					},
				],
			},
		});
	});
});
