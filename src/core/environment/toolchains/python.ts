import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import * as z from "zod";

import { stableHash } from "../../config/loader.js";
import { findExecutable, findFirstExecutable } from "../../lsp/command.js";
import { probeFailure, runProbe } from "../probe.js";
import { sourceLabel, type ToolchainAdapter, type ToolchainResolution, unavailableToolchain } from "./types.js";

const PROBE_SCRIPT = [
	"import json, sys",
	"print(json.dumps({'executable': sys.executable, 'prefix': sys.prefix, 'base_prefix': sys.base_prefix,",
	" 'version': '.'.join(str(part) for part in sys.version_info[:3]), 'path': [p for p in sys.path if p]}))",
].join("\n");

const ProbeOutputSchema = z.object({
	executable: z.string(),
	prefix: z.string(),
	base_prefix: z.string(),
	version: z.string(),
	path: z.array(z.string()),
});

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function unavailable(source: string, problem: string, facts: Record<string, string | null> = {}): ToolchainResolution {
	return unavailableToolchain("python", source, problem, facts);
}

export const resolvePython: ToolchainAdapter = async ({ environment, projectRoot, workspaceRoot, config, signal }) => {
	const env = environment.variables;
	const virtualEnv = env["VIRTUAL_ENV"];
	const condaPrefix = env["CONDA_PREFIX"];
	const fixed = config.pythonInterpreter;

	let interpreter: string | undefined;
	let origin: string;
	if (fixed !== undefined) {
		interpreter = findExecutable(fixed.path, env, workspaceRoot);
		origin = `environment.python.interpreter (${fixed.source} config)`;
		if (interpreter === undefined)
			return unavailable(origin, `Configured interpreter ${fixed.path} is not an executable file.`);
	} else {
		origin = sourceLabel(virtualEnv ? "VIRTUAL_ENV" : condaPrefix ? "CONDA_PREFIX" : "shell PATH", environment);
		if (virtualEnv && !existsSync(virtualEnv)) {
			return unavailable(origin, `VIRTUAL_ENV points to a missing directory: ${virtualEnv}`, { virtualEnv });
		}
		interpreter = findFirstExecutable(process.platform === "win32" ? ["python"] : ["python", "python3"], env);
		if (interpreter === undefined)
			return unavailable(origin, "No Python interpreter is on the PATH of this environment.");
	}

	const result = await runProbe(interpreter, ["-c", PROBE_SCRIPT], { env, ...(signal ? { signal } : {}) });
	if (result.exitCode !== 0) return unavailable(origin, probeFailure(interpreter, result), { interpreter });
	const parsed = ProbeOutputSchema.safeParse(safeJson(result.stdout));
	if (!parsed.success) return unavailable(origin, `${interpreter} printed unexpected probe output`, { interpreter });
	const info = parsed.data;

	const facts: Record<string, string | null> = {
		interpreter,
		executable: info.executable,
		version: info.version,
		prefix: info.prefix,
		basePrefix: info.base_prefix,
		virtualEnv: virtualEnv ?? null,
		condaPrefix: condaPrefix ?? null,
		pythonPath: env["PYTHONPATH"] ?? null,
		pythonHome: env["PYTHONHOME"] ?? null,
	};
	const notes: string[] = [];
	const prefix = canonical(info.prefix);

	if (fixed === undefined) {
		if (virtualEnv && canonical(virtualEnv) !== prefix) {
			return unavailable(
				origin,
				`VIRTUAL_ENV is ${virtualEnv} but the PATH interpreter ${interpreter} runs from ${info.prefix}. ` +
					"Re-activate the environment or fix PATH.",
				facts,
			);
		}
		if (!virtualEnv && condaPrefix && canonical(condaPrefix) !== prefix) {
			return unavailable(
				origin,
				`CONDA_PREFIX is ${condaPrefix} but the PATH interpreter ${interpreter} runs from ${info.prefix}. ` +
					"Re-activate the Conda environment or fix PATH.",
				facts,
			);
		}
	} else if ((virtualEnv && canonical(virtualEnv) !== prefix) || (condaPrefix && canonical(condaPrefix) !== prefix)) {
		notes.push(`The configured interpreter overrides the shell's active environment (${virtualEnv ?? condaPrefix}).`);
	}

	const uvProject = env["UV_PROJECT_ENVIRONMENT"];
	const projectEnvironments = [
		...(uvProject ? [isAbsolute(uvProject) ? uvProject : join(projectRoot, uvProject)] : []),
		join(projectRoot, ".venv"),
	];
	for (const candidate of new Set(projectEnvironments)) {
		if (existsSync(candidate) && canonical(candidate) !== prefix) {
			notes.push(
				`Project environment ${candidate} exists but this call uses ${info.prefix}; ` +
					"activate it in the shell or set environment.python.interpreter to use it.",
			);
		}
	}

	return {
		kind: "python",
		status: "resolved",
		source: origin,
		summary: `Python ${info.version} at ${interpreter} (prefix ${info.prefix})`,
		facts,
		notes,
		settings: { python: { pythonPath: interpreter } },
		fingerprint: stableHash({
			interpreter,
			executable: info.executable,
			prefix: info.prefix,
			version: info.version,
			path: info.path,
			pythonHome: env["PYTHONHOME"] ?? null,
		}),
	};
};

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text.trim().split(/\r?\n/).at(-1) ?? "");
	} catch {
		return undefined;
	}
}
