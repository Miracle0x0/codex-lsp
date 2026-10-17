import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigSources } from "../../src/core/config/loader.js";

/**
 * Variables a child process needs to start at all. Everything else a test's processes see is declared by
 * the test, so a developer's configuration, activated environments, or login state cannot change results.
 */
const STARTUP_VARIABLES = new Set([
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"COMSPEC",
	"WINDIR",
	"TEMP",
	"TMP",
	"TMPDIR",
	"LANG",
	"LC_ALL",
]);

/**
 * Variables that select an environment, configuration, or toolchain. Suites that must use the machine's real
 * toolchains (integration, contract) still inherit the rest of the environment but never these.
 */
const SELECTION_PREFIXES = ["CODEX_LSP_", "LSP_TOOLS_MCP_", "CONDA_", "VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME"];
const SELECTION_VARIABLES = new Set(["RUSTUP_TOOLCHAIN", "NODE_OPTIONS", "CODEX_HOME", "_CE_CONDA", "_CE_M"]);

function isSelection(name: string): boolean {
	return SELECTION_VARIABLES.has(name) || SELECTION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The parent environment without anything that selects an environment, configuration, or toolchain. */
export function toolchainEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== undefined && !isSelection(name)) env[name] = value;
	}
	return env;
}

export interface IsolatedContext {
	/** Real path of a fresh temporary directory owning everything below. */
	readonly root: string;
	/** Empty home directory: no user configuration, Codex login, or shell rc files. */
	readonly home: string;
	/** `CODEX_LSP_STATE_DIR` for captured environments. */
	readonly stateDir: string;
	/** Complete environment for child processes: startup variables plus the private home and state. */
	readonly env: Record<string, string>;
	/** Configuration sources for an in-process runtime: only files the test writes are loaded. */
	readonly config: ConfigSources;
	cleanup(): void;
}

/** Creates a private root for one scenario; `extra` adds variables the scenario declares. */
export function isolatedContext(prefix: string, extra: Readonly<Record<string, string>> = {}): IsolatedContext {
	const root = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
	const home = join(root, "home");
	const stateDir = join(root, "state");
	mkdirSync(home);
	const env: Record<string, string> = {};
	// Matched case-insensitively and copied under the parent's own spelling (Windows has "Path", not "PATH").
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && STARTUP_VARIABLES.has(name.toUpperCase())) env[name] = value;
	}
	Object.assign(env, {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		CODEX_LSP_STATE_DIR: stateDir,
		...extra,
	});
	return {
		root,
		home,
		stateDir,
		env,
		config: { env: {}, homeDir: home },
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
