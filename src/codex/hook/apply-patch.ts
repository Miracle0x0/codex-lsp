import { isAbsolute, normalize, resolve } from "node:path";

import type { FileChange } from "../../core/index.js";

/** One file operation of a Codex apply_patch payload. */
export type PatchOperation =
	| { readonly kind: "add" | "update" | "delete"; readonly path: string }
	| { readonly kind: "move"; readonly from: string; readonly path: string };

const HEADERS = [
	["*** Add File: ", "add"],
	["*** Update File: ", "update"],
	["*** Delete File: ", "delete"],
] as const;
const MOVE_TO = "*** Move to: ";

function absolute(path: string, cwd: string): string {
	return isAbsolute(path) ? normalize(path) : resolve(cwd, path);
}

/** Parses the file headers of a patch; relative paths resolve against the tool call's cwd. */
export function parsePatch(patch: string, cwd: string): PatchOperation[] {
	const operations: PatchOperation[] = [];
	for (const line of patch.split(/\r?\n/)) {
		if (line.startsWith(MOVE_TO)) {
			const previous = operations.at(-1);
			if (previous?.kind === "update") {
				operations[operations.length - 1] = {
					kind: "move",
					from: previous.path,
					path: absolute(line.slice(MOVE_TO.length).trim(), cwd),
				};
			}
			continue;
		}
		for (const [prefix, kind] of HEADERS) {
			if (line.startsWith(prefix)) operations.push({ kind, path: absolute(line.slice(prefix.length).trim(), cwd) });
		}
	}
	return operations;
}

/**
 * Codex reports apply_patch results as text starting with `Exit code: N`. A non-zero code means the
 * patch was not applied; text without an exit code is treated as applied and checked against disk.
 */
export function patchApplied(response: unknown): boolean {
	if (typeof response === "string") {
		const exit = /^Exit code: (\d+)/m.exec(response);
		return exit === null || exit[1] === "0";
	}
	if (typeof response === "object" && response !== null) {
		const record = response as Record<string, unknown>;
		return record["isError"] !== true && record["is_error"] !== true && record["success"] !== false;
	}
	return true;
}

const CHANGE_KIND = { add: "created", update: "changed", delete: "deleted" } as const;

export function patchFileChanges(operations: readonly PatchOperation[]): FileChange[] {
	return operations.flatMap((operation): FileChange[] =>
		operation.kind === "move"
			? [
					{ path: operation.from, kind: "deleted" },
					{ path: operation.path, kind: "created" },
				]
			: [{ path: operation.path, kind: CHANGE_KIND[operation.kind] }],
	);
}
