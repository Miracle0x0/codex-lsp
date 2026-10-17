import { type FSWatcher, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileChangeJournal } from "../../src/core/workspace/journal.js";

// Deliver precise watcher sequences against real files. Real OS delivery is covered in test/platform/.
const watchers = vi.hoisted(() => new Map<string, FSWatcher>());
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const { EventEmitter } = await import("node:events");
	return {
		...fs,
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
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	expect(watchers.size).toBe(0);
});

function journalIn(files: Record<string, string>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lsp-journal-events-")));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	const journal = new FileChangeJournal(root, { exclude: [], drainMs: 0 });
	cleanups.push(() => {
		journal.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { root, journal };
}

function notify(directory: string, name: string, kind = "rename"): void {
	const watcher = watchers.get(directory);
	if (watcher === undefined) throw new Error(`no watcher for ${directory}`);
	watcher.emit("change", kind, name);
}

describe("journal event reconciliation", () => {
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

	it("#given a tracked directory #when it is removed #then only its known files are reported as deleted", async () => {
		const { root, journal } = journalIn({ "pkg/a.txt": "a", "pkg/deep/b.txt": "b" });
		const mark = journal.mark();
		rmSync(join(root, "pkg"), { recursive: true });
		notify(root, "pkg");
		expect((await journal.collect(mark)).changes).toEqual([
			{ path: join(root, "pkg", "a.txt"), kind: "deleted" },
			{ path: join(root, "pkg", "deep", "b.txt"), kind: "deleted" },
		]);
		expect([...watchers.keys()]).toEqual([root]);
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
