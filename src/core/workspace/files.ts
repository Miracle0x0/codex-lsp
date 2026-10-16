import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories that hold dependencies, VCS data, caches, or build output rather than sources. */
export const DEFAULT_EXCLUDED_DIRECTORIES = [
	".git",
	".hg",
	".svn",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".next",
	"dist",
	"build",
	"out",
	"target",
] as const;

export interface WalkOptions {
	/** Directory names or root-relative path prefixes to skip, in addition to the defaults. */
	readonly exclude: readonly string[];
	readonly maxFiles: number | undefined;
	readonly signal: AbortSignal;
}

export interface WalkResult {
	readonly files: readonly string[];
	readonly excludedDirectories: number;
	readonly unreadableDirectories: readonly string[];
	/** True when maxFiles stopped the walk before every file was seen. */
	readonly limitReached: boolean;
}

function normalizePrefix(prefix: string): string {
	return prefix.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Decides whether a directory under `root` is skipped: default names plus configured names or path prefixes. */
export function excludedDirectoryMatcher(root: string, exclude: readonly string[]): (path: string) => boolean {
	const names = new Set<string>(DEFAULT_EXCLUDED_DIRECTORIES);
	const prefixes: string[] = [];
	for (const entry of exclude) {
		const normalized = normalizePrefix(entry);
		if (normalized.includes("/")) prefixes.push(normalized);
		else names.add(normalized);
	}
	return (path) => {
		const offset = relative(root, path).split(sep).join("/");
		const name = offset.slice(offset.lastIndexOf("/") + 1);
		return names.has(name) || prefixes.some((prefix) => offset === prefix || offset.startsWith(`${prefix}/`));
	};
}

export function walkFiles(root: string, options: WalkOptions): WalkResult {
	const isExcluded = excludedDirectoryMatcher(root, options.exclude);
	const files: string[] = [];
	const unreadable: string[] = [];
	let excluded = 0;
	let limitReached = false;

	const visit = (directory: string): void => {
		options.signal.throwIfAborted();
		let entries: string[];
		try {
			entries = readdirSync(directory).sort();
		} catch {
			unreadable.push(directory);
			return;
		}
		for (const entry of entries) {
			if (limitReached) return;
			const path = join(directory, entry);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (isExcluded(path)) {
					excluded += 1;
					continue;
				}
				visit(path);
			} else if (stat.isFile()) {
				if (options.maxFiles !== undefined && files.length >= options.maxFiles) {
					limitReached = true;
					return;
				}
				files.push(path);
			}
		}
	};
	visit(root);
	return { files, excludedDirectories: excluded, unreadableDirectories: unreadable, limitReached };
}
