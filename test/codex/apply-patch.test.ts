import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePatch, patchApplied, patchFileChanges } from "../../src/codex/hook/apply-patch.js";

describe("apply_patch parsing", () => {
	it("#given add, update, delete, and move headers #when parsing #then each operation resolves against cwd", () => {
		// given
		const cwd = resolve(tmpdir(), "codex-lsp-patch");
		const added = join(cwd, "new.ts");
		const updated = join(cwd, "src", "a.ts");
		const deleted = join(cwd, "gone.ts");
		const movedFrom = join(cwd, "old.ts");
		const movedTo = join(cwd, "dir", "moved.ts");
		const patch = [
			"*** Begin Patch",
			`*** Add File: ${added}`,
			"+x",
			"*** Update File: src/a.ts",
			"@@",
			`*** Delete File: ${deleted}`,
			`*** Update File: ${movedFrom}`,
			`*** Move to: ${movedTo}`,
			"@@",
			"*** End Patch",
		].join("\n");

		// when
		const operations = parsePatch(patch, cwd);

		// then
		expect(operations).toEqual([
			{ kind: "add", path: added },
			{ kind: "update", path: updated },
			{ kind: "delete", path: deleted },
			{ kind: "move", from: movedFrom, path: movedTo },
		]);
		expect(patchFileChanges(operations)).toEqual([
			{ path: added, kind: "created" },
			{ path: updated, kind: "changed" },
			{ path: deleted, kind: "deleted" },
			{ path: movedFrom, kind: "deleted" },
			{ path: movedTo, kind: "created" },
		]);
	});

	it("#given Codex result text #when deciding whether the patch applied #then the exit code decides", () => {
		expect(patchApplied("Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.")).toBe(true);
		expect(patchApplied("Exit code: 1\nOutput:\napply_patch verification failed")).toBe(false);
		expect(patchApplied({ isError: true })).toBe(false);
		expect(patchApplied("Success. Updated the following files:")).toBe(true);
	});
});
