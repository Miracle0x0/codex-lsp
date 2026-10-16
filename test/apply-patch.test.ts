import { describe, expect, it } from "vitest";

import { parsePatch, patchApplied, patchFileChanges } from "../src/hook/apply-patch.js";

describe("apply_patch parsing", () => {
	it("#given add, update, delete, and move headers #when parsing #then each operation resolves against cwd", () => {
		// given
		const patch = [
			"*** Begin Patch",
			"*** Add File: /w/new.ts",
			"+x",
			"*** Update File: src/a.ts",
			"@@",
			"*** Delete File: /w/gone.ts",
			"*** Update File: /w/old.ts",
			"*** Move to: /w/dir/moved.ts",
			"@@",
			"*** End Patch",
		].join("\n");

		// when
		const operations = parsePatch(patch, "/w");

		// then
		expect(operations).toEqual([
			{ kind: "add", path: "/w/new.ts" },
			{ kind: "update", path: "/w/src/a.ts" },
			{ kind: "delete", path: "/w/gone.ts" },
			{ kind: "move", from: "/w/old.ts", path: "/w/dir/moved.ts" },
		]);
		expect(patchFileChanges(operations)).toEqual([
			{ path: "/w/new.ts", kind: "created" },
			{ path: "/w/src/a.ts", kind: "changed" },
			{ path: "/w/gone.ts", kind: "deleted" },
			{ path: "/w/old.ts", kind: "deleted" },
			{ path: "/w/dir/moved.ts", kind: "created" },
		]);
	});

	it("#given Codex result text #when deciding whether the patch applied #then the exit code decides", () => {
		expect(patchApplied("Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.")).toBe(true);
		expect(patchApplied("Exit code: 1\nOutput:\napply_patch verification failed")).toBe(false);
		expect(patchApplied({ isError: true })).toBe(false);
		expect(patchApplied("Success. Updated the following files:")).toBe(true);
	});
});
