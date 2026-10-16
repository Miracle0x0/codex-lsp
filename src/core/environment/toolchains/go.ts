import * as z from "zod";

import { stableHash } from "../../config/loader.js";
import { findExecutable } from "../../lsp/command.js";
import { probeFailure, runProbe } from "../probe.js";
import { sourceLabel, type ToolchainAdapter, unavailableToolchain } from "./types.js";

const GO_ENV_KEYS = ["GOROOT", "GOPATH", "GOVERSION", "GOWORK", "GOMOD", "GOFLAGS", "GOOS", "GOARCH"] as const;
const GoEnvSchema = z.record(z.string(), z.string());

export const resolveGo: ToolchainAdapter = async ({ environment, projectRoot, signal }) => {
	const requestedToolchain = environment.variables["GOTOOLCHAIN"] ?? null;
	// GOTOOLCHAIN=local keeps the probe from downloading a toolchain that go.mod asks for.
	const env = { ...environment.variables, GOTOOLCHAIN: "local" };
	const source = sourceLabel(environment.variables["GOROOT"] ? "GOROOT" : "shell PATH", environment);
	const go = findExecutable("go", env);
	const facts: Record<string, string | null> = { go: go ?? null, requestedToolchain };
	const fail = (problem: string) => unavailableToolchain("go", source, problem, facts);
	if (go === undefined) return fail("No go executable is on the PATH of this environment.");
	const result = await runProbe(go, ["env", "-json", ...GO_ENV_KEYS], {
		env,
		cwd: projectRoot,
		...(signal ? { signal } : {}),
	});
	if (result.exitCode !== 0) return fail(`${probeFailure(go, result)} (probe runs with GOTOOLCHAIN=local)`);
	const parsed = GoEnvSchema.safeParse(safeJson(result.stdout));
	if (!parsed.success) return fail(`${go} env -json printed unexpected output`);
	for (const key of GO_ENV_KEYS) facts[key] = parsed.data[key] || null;
	return {
		kind: "go",
		status: "resolved",
		source,
		summary: `${facts["GOVERSION"]} at ${facts["GOROOT"]}${facts["GOWORK"] ? `, workspace ${facts["GOWORK"]}` : facts["GOMOD"] ? `, module ${facts["GOMOD"]}` : ""}`,
		facts,
		notes: [],
		fingerprint: stableHash(facts),
	};
};

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
