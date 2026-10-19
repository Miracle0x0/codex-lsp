import { type FSWatcher, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { journalFixture } from "../support/journal.js";

// Deliver precise watcher sequences against real files. Real OS delivery is covered in test/platform/.
const watchers = vi.hoisted(() => new Map<string, FSWatcher>());
const unreadableDirectories = vi.hoisted(() => new Set<string>());
const uninspectablePaths = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const { EventEmitter } = await import("node:events");
	return {
		...fs,
		lstatSync(path: string, options: { bigint: true }) {
			if (uninspectablePaths.has(path)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			return fs.lstatSync(path, options);
		},
		readdirSync(directory: string) {
			if (unreadableDirectories.has(directory)) throw new Error(`cannot read ${directory}`);
			return fs.readdirSync(directory);
		},
		watch(directory: string, _options: unknown, listener: (kind: string, name: string | Buffer | null) => void) {
			const watcher: FSWatcher = Object.assign(new EventEmitter(), {
				close() {
					watchers.delete(directory);
				},
				ref(): FSWatcher {
					return watcher;
				},
				unref(): FSWatcher {
					return watcher;
				},
			});
			watcher.on("change", listener);
			watchers.set(directory, watcher);
			return watcher;
		},
	};
});

const cleanups: Array<() => void> = [];
const journalIn = journalFixture(cleanups);
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	unreadableDirectories.clear();
	uninspectablePaths.clear();
	expect(watchers.size).toBe(0);
});

function notify(directory: string, name: string, kind = "rename"): void {
	const watcher = watchers.get(directory);
	if (watcher === undefined) throw new Error(`no watcher for ${directory}`);
	watcher.emit("change", kind, name);
}

describe("journal event reconciliation", () => {
	it("#given watchers have not delivered any events #when a source and excluded files change #then only the source is reported", async () => {
		const paths = ["node_modules/dep/index.js", "generated/out.ts", "src/a.ts"];
		const { root, journal } = journalIn(Object.fromEntries(paths.map((path) => [path, "a"])), {
			exclude: ["generated"],
		});
		const mark = journal.mark();
		for (const path of paths) writeFileSync(join(root, path), "b");
		expect(await journal.collect(mark)).toEqual({
			changes: [{ path: join(root, "src", "a.ts"), kind: "changed" }],
			incompleteReasons: [],
		});
	});

	it("#given no watcher notifications #when files and a nested directory change #then the window reflects disk state", async () => {
		const { root, journal } = journalIn({ "edit.txt": "a", "drop.txt": "a" });
		const mark = journal.mark();
		writeFileSync(join(root, "edit.txt"), "changed");
		unlinkSync(join(root, "drop.txt"));
		mkdirSync(join(root, "pkg", "deep"), { recursive: true });
		writeFileSync(join(root, "pkg", "deep", "new.ts"), "created");
		const window = await journal.collect(mark);
		expect(window.changes).toEqual(
			expect.arrayContaining([
				{ path: join(root, "edit.txt"), kind: "changed" },
				{ path: join(root, "drop.txt"), kind: "deleted" },
				{ path: join(root, "pkg", "deep", "new.ts"), kind: "created" },
			]),
		);
		expect(window.changes).toHaveLength(3);
		expect(window.incompleteReasons).toEqual([]);
		expect(watchers.has(join(root, "pkg", "deep"))).toBe(true);
		const after = journal.mark();
		notify(root, "edit.txt", "change");
		expect((await journal.collect(after)).changes).toEqual([]);
	});

	it("#given an unreported edit before the mark #when its delayed notification arrives #then the next window excludes it", async () => {
		const { root, journal } = journalIn({ "a.txt": "a" });
		writeFileSync(join(root, "a.txt"), "changed before the mark");
		const mark = journal.mark();
		notify(root, "a.txt", "change");
		expect((await journal.collect(mark)).changes).toEqual([]);
	});

	it.each([false, true])(
		"#given a tracked subtree #when it is removed (notification: %s) #then its files are deleted and watchers close",
		async (notified) => {
			const { root, journal } = journalIn({ "pkg/a.txt": "a", "pkg/deep/b.txt": "b" });
			const mark = journal.mark();
			rmSync(join(root, "pkg"), { recursive: true });
			if (notified) notify(root, "pkg");
			const window = await journal.collect(mark);
			expect(window.changes).toEqual([
				{ path: join(root, "pkg", "a.txt"), kind: "deleted" },
				{ path: join(root, "pkg", "deep", "b.txt"), kind: "deleted" },
			]);
			expect([...watchers.keys()]).toEqual([root]);
		},
	);

	it("#given an unreadable directory #when collecting #then its files are not reported deleted and coverage is incomplete", async () => {
		const { root, journal } = journalIn({ "pkg/a.txt": "a", "pkg/deep/b.txt": "b" });
		const mark = journal.mark();
		const directory = join(root, "pkg");
		unreadableDirectories.add(directory);
		const window = await journal.collect(mark);
		expect(window.changes).toEqual([]);
		expect(window.incompleteReasons).toContain(`cannot read directory ${directory}`);
		expect(watchers.has(join(directory, "deep"))).toBe(true);
	});

	it("#given a removed root without notifications #when collecting #then known files are deleted and the journal stays closed", async () => {
		const { root, journal } = journalIn({ "a.txt": "a" });
		const mark = journal.mark();
		rmSync(root, { recursive: true });
		const window = await journal.collect(mark);
		expect(window.changes).toEqual([{ path: join(root, "a.txt"), kind: "deleted" }]);
		expect(window.incompleteReasons).toContain("the workspace file journal was closed before this command finished");
		mkdirSync(root);
		journal.mark();
		expect(watchers.size).toBe(0);
	});

	it("#given a listed file whose metadata is unreadable #when collecting #then it is retained and the error is reported", async () => {
		const { root, journal } = journalIn({ "a.txt": "a" });
		const mark = journal.mark();
		const path = join(root, "a.txt");
		uninspectablePaths.add(path);
		notify(root, "a.txt", "change");
		const window = await journal.collect(mark);
		expect(window.changes).toEqual([]);
		expect(window.incompleteReasons).toContain(`cannot inspect ${path}: permission denied`);
		uninspectablePaths.clear();
		writeFileSync(path, "changed");
		expect((await journal.collect(mark)).changes).toEqual([{ path, kind: "changed" }]);
	});

	it("#given initial files #when delayed file and directory-self notifications arrive #then the window stays empty", async () => {
		const { root, journal } = journalIn({ "a.txt": "a" });
		const mark = journal.mark();
		notify(root, "a.txt", "change");
		notify(root, basename(root));
		expect(await journal.collect(mark)).toEqual({ changes: [], incompleteReasons: [] });
	});

	it("#given an observed edit #when its duplicate notification arrives in a later window #then the edit is not reported again", async () => {
		const { root, journal } = journalIn({ "a.txt": "a" });
		const mark = journal.mark();
		writeFileSync(join(root, "a.txt"), "changed");
		notify(root, "a.txt", "change");
		expect((await journal.collect(mark)).changes).toEqual([{ path: join(root, "a.txt"), kind: "changed" }]);

		const after = journal.mark();
		notify(root, "a.txt", "change");
		expect((await journal.collect(after)).changes).toEqual([]);
	});

	it("#given a child named like its parent #when it is created and deleted #then both real changes are tracked", async () => {
		const { root, journal } = journalIn({});
		const name = basename(root);
		const path = join(root, name);
		const created = journal.mark();
		writeFileSync(path, "x");
		notify(root, name);
		expect((await journal.collect(created)).changes).toEqual([{ path, kind: "created" }]);

		const deleted = journal.mark();
		unlinkSync(path);
		notify(root, name);
		expect((await journal.collect(deleted)).changes).toEqual([{ path, kind: "deleted" }]);
	});

	it("#given a watched root #when its own removal is reported by basename #then its files are deleted and watchers close", async () => {
		const { root, journal } = journalIn({ "a.txt": "a" });
		const mark = journal.mark();
		rmSync(root, { recursive: true });
		notify(root, basename(root));
		const window = await journal.collect(mark);
		expect(window.changes).toEqual([{ path: join(root, "a.txt"), kind: "deleted" }]);
		expect(window.incompleteReasons).toContain("the workspace file journal was closed before this command finished");
		expect(watchers.size).toBe(0);
	});
});
