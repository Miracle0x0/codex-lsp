import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	FileChangeJournal,
	type JournalMark,
	type JournalOptions,
	type JournalWindow,
} from "../../src/core/workspace/journal.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function journalIn(files: Record<string, string>, options: Partial<JournalOptions> = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lsp-journal-")));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const journal = new FileChangeJournal(root, { exclude: [], drainMs: 0, ...options });
	cleanups.push(() => {
		journal.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { root, journal };
}

/**
 * Collects the window until `done` holds. fs.watch delivers events asynchronously and at platform-dependent
 * times, so the test waits for the observable result instead of assuming a fixed delay; it gives up at a deadline.
 */
async function collectUntil(
	journal: FileChangeJournal,
	mark: JournalMark,
	done: (window: JournalWindow) => boolean,
	timeoutMs = 5_000,
): Promise<JournalWindow> {
	const deadline = Date.now() + timeoutMs;
	let window = await journal.collect(mark);
	while (!done(window) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		window = await journal.collect(mark);
	}
	return window;
}

const touched = (window: JournalWindow, ...paths: string[]): boolean =>
	paths.every((path) => window.changes.some((change) => change.path === path));

function sorted(changes: readonly { path: string; kind: string }[]) {
	return [...changes].sort((a, b) => a.path.localeCompare(b.path));
}

describe("FileChangeJournal", () => {
	it("#given a window #when files are created, changed, and deleted #then each is classified and earlier changes are excluded", async () => {
		// given
		const { root, journal } = journalIn({ "keep.txt": "a", "edit.txt": "a", "drop.txt": "a", "before.txt": "a" });
		const start = journal.mark();
		writeFileSync(join(root, "before.txt"), "changed before the mark");
		await collectUntil(journal, start, (window) => touched(window, join(root, "before.txt")));
		const mark = journal.mark();

		// when
		writeFileSync(join(root, "new.txt"), "x");
		writeFileSync(join(root, "edit.txt"), "b");
		unlinkSync(join(root, "drop.txt"));
		const window = await collectUntil(journal, mark, (current) =>
			touched(current, join(root, "new.txt"), join(root, "edit.txt"), join(root, "drop.txt")),
		);

		// then
		expect(sorted(window.changes)).toEqual([
			{ path: join(root, "drop.txt"), kind: "deleted" },
			{ path: join(root, "edit.txt"), kind: "changed" },
			{ path: join(root, "new.txt"), kind: "created" },
		]);
		expect(window.incompleteReasons).toEqual([]);
	});

	it("#given a directory created inside the window #when files are written in it #then they are reported as created", async () => {
		// given
		const { root, journal } = journalIn({ "a.txt": "a" });
		const mark = journal.mark();

		// when
		mkdirSync(join(root, "pkg", "deep"), { recursive: true });
		writeFileSync(join(root, "pkg", "deep", "mod.py"), "x = 1\n");
		await collectUntil(journal, mark, (window) => touched(window, join(root, "pkg", "deep", "mod.py")));
		writeFileSync(join(root, "pkg", "late.py"), "y = 2\n");
		const window = await collectUntil(journal, mark, (current) =>
			touched(current, join(root, "pkg", "deep", "mod.py"), join(root, "pkg", "late.py")),
		);

		// then
		expect(sorted(window.changes)).toEqual([
			{ path: join(root, "pkg", "deep", "mod.py"), kind: "created" },
			{ path: join(root, "pkg", "late.py"), kind: "created" },
		]);
	});

	it("#given dependency and configured directories #when files change there #then they are not tracked", async () => {
		// given
		const { root, journal } = journalIn(
			{ "node_modules/dep/index.js": "a", "generated/out.ts": "a", "src/a.ts": "a" },
			{ exclude: ["generated"] },
		);
		const mark = journal.mark();

		// when
		writeFileSync(join(root, "node_modules", "dep", "index.js"), "b");
		writeFileSync(join(root, "generated", "out.ts"), "b");
		writeFileSync(join(root, "src", "a.ts"), "b");
		const window = await collectUntil(journal, mark, (current) => touched(current, join(root, "src", "a.ts")));

		// then
		expect(window.changes).toEqual([{ path: join(root, "src", "a.ts"), kind: "changed" }]);
	});

	it("#given more directories than the watch limit #when collecting #then the window is reported incomplete", async () => {
		// given
		const { journal } = journalIn({ "a/x.txt": "", "b/x.txt": "", "c/x.txt": "" }, { maxDirectories: 2 });

		// when
		const window = await journal.collect(journal.mark());

		// then
		expect(window.incompleteReasons.join("\n")).toContain("more than 2 directories");
	});

	it("#given more events than retained #when collecting an old window #then dropped events are reported", async () => {
		// given
		const { root, journal } = journalIn({}, { maxEvents: 3 });
		const mark = journal.mark();

		// when
		for (let index = 0; index < 6; index += 1) writeFileSync(join(root, `f${index}.txt`), "x");
		const window = await collectUntil(journal, mark, (current) =>
			current.incompleteReasons.some((reason) => reason.includes("dropped")),
		);

		// then
		expect(window.incompleteReasons.join("\n")).toContain("dropped");
	});
});
