import { type BigIntStats, type FSWatcher, lstatSync, readdirSync, watch } from "node:fs";
import { basename, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { FileChange } from "../documents/store.js";
import { JOURNAL_DRAIN_MS, JOURNAL_MAX_DIRECTORIES, JOURNAL_MAX_EVENTS } from "../lsp/constants.js";
import { excludedDirectoryMatcher } from "./files.js";

export interface JournalOptions {
	readonly exclude: readonly string[];
	readonly maxDirectories?: number;
	readonly maxEvents?: number;
	readonly drainMs?: number;
}

export interface JournalWindow {
	readonly changes: readonly FileChange[];
	/** Why the window may be missing changes; empty when every watched event is accounted for. */
	readonly incompleteReasons: readonly string[];
}

export interface JournalMark {
	readonly seq: number;
	readonly files: ReadonlySet<string>;
}

interface JournalEvent {
	readonly seq: number;
	readonly path: string;
}

function statOf(path: string): BigIntStats | undefined {
	try {
		return lstatSync(path, { bigint: true });
	} catch {
		return undefined;
	}
}

/** Identity and write metadata; nanosecond timestamps retain changes within the same millisecond. */
function fileStamp(stat: BigIntStats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Records file changes under a workspace from per-directory watchers, so edits made by processes the
 * runtime does not see (shell commands, build tools) can be found for a time window. Dependency and
 * build directories are not watched.
 */
export class FileChangeJournal {
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly files = new Map<string, string>();
	private readonly events: JournalEvent[] = [];
	private readonly isExcluded: (path: string) => boolean;
	private readonly maxDirectories: number;
	private readonly maxEvents: number;
	private readonly drainMs: number;
	/** Problems that make every later window incomplete (unwatched directories, failed watchers). */
	private readonly standingProblems = new Set<string>();
	/** Problems tied to the event sequence at which they happened. */
	private readonly problems: Array<{ readonly seq: number; readonly reason: string }> = [];
	private seq = 0;
	private droppedThrough = 0;
	private closed = false;

	constructor(
		readonly root: string,
		options: JournalOptions,
	) {
		this.isExcluded = excludedDirectoryMatcher(root, options.exclude);
		this.maxDirectories = options.maxDirectories ?? JOURNAL_MAX_DIRECTORIES;
		this.maxEvents = options.maxEvents ?? JOURNAL_MAX_EVENTS;
		this.drainMs = options.drainMs ?? JOURNAL_DRAIN_MS;
		this.watchTree(root, false);
	}

	/** Position to pass to `collect` later; changes after it belong to the window. */
	mark(): JournalMark {
		return { seq: this.seq, files: new Set(this.files.keys()) };
	}

	/** Files created, changed, or deleted after `mark`, classified by their state now. */
	async collect(mark: JournalMark): Promise<JournalWindow> {
		await delay(this.drainMs);
		const reasons = [...this.standingProblems];
		if (mark.seq < this.droppedThrough) reasons.push("watch events were dropped because too many changes happened");
		for (const problem of this.problems) if (problem.seq > mark.seq) reasons.push(problem.reason);
		const paths = new Set<string>();
		for (const event of this.events) {
			if (event.seq <= mark.seq) continue;
			paths.add(event.path);
		}
		const changes: FileChange[] = [];
		for (const path of paths) {
			const stat = statOf(path);
			if (stat === undefined) changes.push({ path, kind: "deleted" });
			else if (stat.isFile()) changes.push({ path, kind: mark.files.has(path) ? "changed" : "created" });
		}
		if (this.closed) reasons.push("the workspace file journal was closed before this command finished");
		return { changes, incompleteReasons: [...new Set(reasons)] };
	}

	close(): void {
		this.closed = true;
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
		this.files.clear();
	}

	private record(path: string): void {
		this.seq += 1;
		this.events.push({ seq: this.seq, path });
		if (this.events.length > this.maxEvents) {
			const dropped = this.events.splice(0, this.events.length - this.maxEvents);
			this.droppedThrough = dropped.at(-1)?.seq ?? this.droppedThrough;
			while ((this.problems[0]?.seq ?? Number.POSITIVE_INFINITY) <= this.droppedThrough) this.problems.shift();
		}
	}

	private problem(reason: string): void {
		this.problems.push({ seq: this.seq + 1, reason });
		this.seq += 1;
	}

	/** Watches a directory tree; `recordFiles` records files found as created (a directory that just appeared). */
	private watchTree(directory: string, recordFiles: boolean): void {
		const pending = [directory];
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === undefined || this.watchers.has(current)) continue;
			if (this.watchers.size >= this.maxDirectories) {
				this.standingProblems.add(
					`more than ${this.maxDirectories} directories; changes under unwatched directories are not tracked`,
				);
				return;
			}
			if (!this.watch(current)) continue;
			let entries: string[];
			try {
				entries = readdirSync(current);
			} catch {
				this.standingProblems.add(`cannot read directory ${current}`);
				continue;
			}
			for (const entry of entries) {
				const path = join(current, entry);
				const stat = statOf(path);
				if (stat === undefined || stat.isSymbolicLink()) continue;
				if (stat.isDirectory()) {
					if (!this.isExcluded(path)) pending.push(path);
				} else if (stat.isFile()) {
					this.files.set(path, fileStamp(stat));
					if (recordFiles) this.record(path);
				}
			}
		}
	}

	private watch(directory: string): boolean {
		try {
			const watcher = watch(directory, { persistent: false }, (_kind, name) => this.onEvent(directory, name));
			watcher.on("error", (error) => {
				this.standingProblems.add(`watcher for ${directory} failed: ${error.message}`);
				watcher.close();
				this.watchers.delete(directory);
			});
			this.watchers.set(directory, watcher);
			return true;
		} catch (error) {
			this.standingProblems.add(
				`cannot watch ${directory}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private onEvent(directory: string, name: string | Buffer | null): void {
		if (this.closed) return;
		if (name === null) {
			this.problem(`a change in ${directory} was reported without a file name`);
			return;
		}
		const filename = name.toString();
		// macOS also reports a watched directory's own removal using its basename.
		// A real child with that name is still handled normally while the parent exists.
		if (filename === basename(directory) && statOf(directory) === undefined) {
			this.removeTree(directory);
			return;
		}
		const path = join(directory, filename);
		const stat = statOf(path);
		if (stat?.isDirectory()) {
			if (!this.isExcluded(path)) this.watchTree(path, true);
			return;
		}
		if (stat?.isSymbolicLink()) return;
		if (stat === undefined) {
			this.removeTree(path);
		} else if (stat.isFile()) {
			const stamp = fileStamp(stat);
			// Delayed startup events and duplicate notifications do not represent a new file state.
			if (this.files.get(path) === stamp) return;
			this.files.set(path, stamp);
			this.record(path);
		}
	}

	/** Only files we observed can be deleted; a directory-self event can name no actual child. */
	private removeTree(path: string): void {
		for (const [directory, watcher] of this.watchers) {
			if (directory === path || directory.startsWith(`${path}${sep}`)) {
				watcher.close();
				this.watchers.delete(directory);
			}
		}
		for (const known of this.files.keys()) {
			if (known === path || known.startsWith(`${path}${sep}`)) {
				this.files.delete(known);
				this.record(known);
			}
		}
		if (path === this.root) this.close();
	}
}
