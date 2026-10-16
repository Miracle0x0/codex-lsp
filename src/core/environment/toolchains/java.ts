import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stableHash } from "../../config/loader.js";
import { findExecutable } from "../../lsp/command.js";
import { probeFailure, runProbe } from "../probe.js";
import { firstLine, sourceLabel, type ToolchainAdapter, unavailableToolchain } from "./types.js";

const BUILD_FILES = ["build.gradle.kts", "build.gradle", "pom.xml"] as const;
const TOOLCHAIN_PATTERNS = [
	/languageVersion\s*(?:\.set\s*\(|=)\s*JavaLanguageVersion\.of\(\s*(\d+)\s*\)/,
	/<maven\.compiler\.release>\s*(\d+)\s*</,
	/<release>\s*(\d+)\s*<\/release>/,
	/sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['"]?([\d_.]+)/,
];

/** The project's declared compile JDK, which can differ from the JVM running the language server. */
function projectToolchain(projectRoot: string): string | null {
	for (const name of BUILD_FILES) {
		const path = join(projectRoot, name);
		if (!existsSync(path)) continue;
		const text = readFileSync(path, "utf8");
		for (const pattern of TOOLCHAIN_PATTERNS) {
			const match = pattern.exec(text);
			if (match?.[1]) return `${name}: Java ${match[1].replaceAll("_", ".")}`;
		}
	}
	return null;
}

export const resolveJava: ToolchainAdapter = async ({ environment, projectRoot, signal }) => {
	const env = environment.variables;
	const javaHome = env["JAVA_HOME"];
	const java = javaHome ? findExecutable(join(javaHome, "bin", "java"), env) : findExecutable("java", env);
	const source = sourceLabel(javaHome ? "JAVA_HOME" : "shell PATH", environment);
	const facts: Record<string, string | null> = {
		java: java ?? null,
		javaHome: javaHome ?? null,
		javaVersion: null,
		projectToolchain: projectToolchain(projectRoot),
	};
	const fail = (problem: string) => unavailableToolchain("java", source, problem, facts);
	if (java === undefined) {
		return fail(
			javaHome ? `JAVA_HOME=${javaHome} has no bin/java.` : "No java executable is on the PATH of this environment.",
		);
	}
	const result = await runProbe(java, ["-version"], { env, ...(signal ? { signal } : {}) });
	if (result.exitCode !== 0) return fail(probeFailure(java, result));
	facts["javaVersion"] = firstLine(result.stderr || result.stdout);
	const notes =
		facts["projectToolchain"] === null
			? []
			: [`The project declares ${facts["projectToolchain"]}; the language server JVM is ${facts["javaVersion"]}.`];
	return {
		kind: "java",
		status: "resolved",
		source,
		summary: `${facts["javaVersion"]} at ${java}`,
		facts,
		notes,
		fingerprint: stableHash(facts),
	};
};
