import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, loadEffectiveConfig, PROJECT_CONFIG_ENV, USER_CONFIG_ENV } from "../../src/core/config/loader.js";

let workspace: string;
let userConfig: string;
const saved = { project: process.env[PROJECT_CONFIG_ENV], user: process.env[USER_CONFIG_ENV] };

function writeProject(config: unknown): void {
	mkdirSync(join(workspace, ".codex"), { recursive: true });
	writeFileSync(join(workspace, ".codex", "lsp-client.json"), JSON.stringify(config));
}

function writeUser(config: unknown): void {
	writeFileSync(userConfig, JSON.stringify(config));
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "lsp-config-"));
	userConfig = join(workspace, "user-config.json");
	delete process.env[PROJECT_CONFIG_ENV];
	process.env[USER_CONFIG_ENV] = userConfig;
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	if (saved.project === undefined) delete process.env[PROJECT_CONFIG_ENV];
	else process.env[PROJECT_CONFIG_ENV] = saved.project;
	if (saved.user === undefined) delete process.env[USER_CONFIG_ENV];
	else process.env[USER_CONFIG_ENV] = saved.user;
});

describe("config v1", () => {
	it("#given no config files #when loading #then builtin routes apply and the project file is looked up under the workspace", () => {
		// when
		const config = loadEffectiveConfig(workspace);

		// then
		expect(config.languageForExtension(".py")).toMatchObject({
			id: "python",
			semanticServer: "pyright",
			diagnosticServers: ["pyright"],
			toolchain: "python",
		});
		expect(config.files.project).toEqual({ path: join(workspace, ".codex", "lsp-client.json"), loaded: false });
		expect(config.environment.source).toBe("active-shell");
	});

	it("#given a user route adding ruff #when the project only changes settings #then routes merge field by field", () => {
		// given
		writeUser({ schemaVersion: 1, languages: { python: { diagnosticServers: ["pyright", "ruff"] } } });
		writeProject({
			schemaVersion: 1,
			servers: {
				pyright: {
					command: ["pyright-langserver", "--stdio"],
					settings: { python: { analysis: { diagnosticMode: "workspace" } } },
				},
			},
		});

		// when
		const config = loadEffectiveConfig(workspace);

		// then
		expect(config.languages.get("python")?.diagnosticServers).toEqual(["pyright", "ruff"]);
		expect(config.servers.get("pyright")).toMatchObject({
			source: "project",
			settings: { python: { analysis: { diagnosticMode: "workspace" } } },
		});
	});

	it("#given a user-enabled server #when the project disables it #then it leaves every route and is reported as disabled", () => {
		// given
		writeUser({ schemaVersion: 1, languages: { python: { diagnosticServers: ["pyright", "ruff"] } } });
		writeProject({ schemaVersion: 1, servers: { ruff: { disabled: true } } });

		// when
		const config = loadEffectiveConfig(workspace);

		// then
		expect(config.servers.has("ruff")).toBe(false);
		expect(config.disabledServers.get("ruff")).toBe("project");
		expect(config.languages.get("python")).toMatchObject({
			diagnosticServers: ["pyright"],
			disabledServers: ["ruff"],
		});
	});

	it("#given a route to an unknown server #when loading #then the error names the file and field", () => {
		// given
		writeProject({ schemaVersion: 1, languages: { python: { diagnosticServers: ["pyright", "nope"] } } });

		// when
		const load = () => loadEffectiveConfig(workspace);

		// then
		expect(load).toThrow(ConfigError);
		try {
			load();
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			if (error instanceof ConfigError) {
				expect(error.issues).toEqual([
					{
						file: join(workspace, ".codex", "lsp-client.json"),
						path: "languages.python.diagnosticServers.1",
						message: "unknown server 'nope'",
					},
				]);
			}
		}
	});

	it("#given two languages claiming one extension #when loading #then the conflict is an error, not a silent pick", () => {
		// given
		writeProject({ schemaVersion: 1, languages: { scripts: { extensions: [".py"], semanticServer: "ruff" } } });

		// then
		expect(() => loadEffectiveConfig(workspace)).toThrow(/extension '\.py' is already routed to language/);
	});

	it("#given the legacy top-level lsp format #when loading #then it is rejected with field errors", () => {
		// given
		writeProject({ lsp: { typescript: { command: ["x"], extensions: [".ts"] } } });

		// then
		expect(() => loadEffectiveConfig(workspace)).toThrow(/schemaVersion/);
	});

	it("#given invalid JSON #when loading #then the error points at the file", () => {
		// given
		mkdirSync(join(workspace, ".codex"), { recursive: true });
		writeFileSync(join(workspace, ".codex", "lsp-client.json"), "{ nope");

		// then
		expect(() => loadEffectiveConfig(workspace)).toThrow(/invalid JSON/);
	});

	it("#given a relative fixed interpreter in project config #when loading #then it resolves against the workspace", () => {
		// given
		writeProject({
			schemaVersion: 1,
			environment: { python: { interpreter: ".venv/bin/python" }, extraVariables: ["MY_VAR"] },
		});

		// when
		const config = loadEffectiveConfig(workspace);

		// then
		expect(config.environment.pythonInterpreter).toEqual({
			path: join(workspace, ".venv", "bin", "python"),
			source: "project",
		});
		expect(config.environment.extraVariables).toEqual(["MY_VAR"]);
	});
});
