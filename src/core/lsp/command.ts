import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

function pathEntries(env: Env): string[] {
	const value = process.platform === "win32" ? (env["PATH"] ?? env["Path"] ?? "") : (env["PATH"] ?? "");
	return value.split(delimiter).filter((entry) => entry.length > 0);
}

function windowsExtensions(env: Env): string[] {
	const raw = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
	const extensions = raw
		.split(";")
		.map((extension) => extension.trim())
		.filter(Boolean)
		.map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
	return ["", ...new Set(extensions)];
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function withExtensions(path: string, env: Env): string | undefined {
	const candidates =
		process.platform === "win32" ? windowsExtensions(env).map((extension) => path + extension) : [path];
	return candidates.find(isExecutableFile);
}

function hasPathSeparator(command: string): boolean {
	return command.includes("/") || command.includes("\\");
}

/**
 * Resolves a configured command the way the bound environment would: absolute paths as-is,
 * relative paths against `baseDir` (the workspace root), bare names through the environment PATH.
 */
export function findExecutable(command: string, env: Env, baseDir?: string): string | undefined {
	if (isAbsolute(command)) return withExtensions(command, env);
	if (hasPathSeparator(command))
		return baseDir === undefined ? undefined : withExtensions(resolve(baseDir, command), env);
	for (const directory of pathEntries(env)) {
		const found = withExtensions(join(directory, command), env);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** First PATH directory that contains any of the names, checking names in order within each directory. */
export function findFirstExecutable(names: readonly string[], env: Env): string | undefined {
	for (const directory of pathEntries(env)) {
		for (const name of names) {
			const found = withExtensions(join(directory, name), env);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}
