import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileChangeJournal, type JournalOptions } from "../../src/core/workspace/journal.js";

export function journalFixture(cleanups: Array<() => void>) {
	return (files: Record<string, string>, options: Partial<JournalOptions> = {}) => {
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
	};
}
