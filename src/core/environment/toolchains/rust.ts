import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stableHash } from "../../config/loader.js";
import { findExecutable } from "../../lsp/command.js";
import { probeFailure, runProbe } from "../probe.js";
import { ancestors, firstLine, sourceLabel, type ToolchainAdapter, unavailableToolchain } from "./types.js";

function toolchainFile(projectRoot: string, workspaceRoot: string | undefined): string | undefined {
	for (const directory of ancestors(projectRoot, workspaceRoot)) {
		for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
			const path = join(directory, name);
			if (existsSync(path)) return path;
		}
	}
	return undefined;
}

export const resolveRust: ToolchainAdapter = async ({ environment, projectRoot, workspaceRoot, signal }) => {
	// Probes must not install toolchains named by rust-toolchain.toml.
	const env = { ...environment.variables, RUSTUP_AUTO_INSTALL: "0" };
	const override = toolchainFile(projectRoot, workspaceRoot);
	const source = sourceLabel(
		environment.variables["RUSTUP_TOOLCHAIN"]
			? "RUSTUP_TOOLCHAIN"
			: override
				? "rust-toolchain file"
				: "rustup default",
		environment,
	);
	const rustc = findExecutable("rustc", env);
	const cargo = findExecutable("cargo", env);
	const facts: Record<string, string | null> = {
		rustc: rustc ?? null,
		cargo: cargo ?? null,
		rustupToolchain: environment.variables["RUSTUP_TOOLCHAIN"] ?? null,
		toolchainFile: override ?? null,
		rustcVersion: null,
		cargoVersion: null,
		sysroot: null,
	};
	const fail = (problem: string) => unavailableToolchain("rust", source, problem, facts);
	if (rustc === undefined) return fail("No rustc is on the PATH of this environment.");
	const options = { env, cwd: projectRoot, ...(signal ? { signal } : {}) };
	const version = await runProbe(rustc, ["--version"], options);
	if (version.exitCode !== 0) return fail(probeFailure(rustc, version));
	const sysroot = await runProbe(rustc, ["--print", "sysroot"], options);
	if (sysroot.exitCode !== 0) return fail(probeFailure(rustc, sysroot));
	facts["rustcVersion"] = firstLine(version.stdout);
	facts["sysroot"] = firstLine(sysroot.stdout);
	if (cargo !== undefined) {
		const cargoVersion = await runProbe(cargo, ["--version"], options);
		facts["cargoVersion"] = cargoVersion.exitCode === 0 ? firstLine(cargoVersion.stdout) : null;
	}
	return {
		kind: "rust",
		status: "resolved",
		source,
		summary: `${facts["rustcVersion"]} (sysroot ${facts["sysroot"]})`,
		facts,
		notes: cargo === undefined ? ["No cargo is on the PATH; rust-analyzer cannot load Cargo workspaces."] : [],
		fingerprint: stableHash({ ...facts, toolchainFileContent: override ? readFileSync(override, "utf8") : null }),
	};
};
