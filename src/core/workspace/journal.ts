import { type BigIntStats, type FSWatcher, lstatSync, readdirSync, watch } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
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

type PathState =
	| { readonly kind: "present"; readonly stat: BigIntStats }
	| { readonly kind: "missing" }
	| { readonly kind: "unreadable" };

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
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
		this.scanTree(root, false);
	}

	/** Position to pass to `collect` later; changes after it belong to the window. */
	mark(): JournalMark {
		// Watch registration and notification delivery are asynchronous on some platforms.
		// Establish the actual pre-command state before assigning changes to a new window.
		if (!this.closed) this.scanTree(this.root, true);
		return { seq: this.seq, files: new Set(this.files.keys()) };
	}

	/** Files created, changed, or deleted after `mark`, classified by their state now. */
	async collect(mark: JournalMark): Promise<JournalWindow> {
		await delay(this.drainMs);
		if (!this.closed) this.scanTree(this.root, true);
		const paths = new Set<string>();
		for (const event of this.events) {
			if (event.seq <= mark.seq) continue;
			paths.add(event.path);
		}
		const changes: FileChange[] = [];
		for (const path of paths) {
			const state = this.statOf(path);
			if (state.kind === "missing") changes.push({ path, kind: "deleted" });
			else if (state.kind === "present" && state.stat.isFile()) {
				changes.push({ path, kind: mark.files.has(path) ? "changed" : "created" });
			}
		}
		const reasons = [...this.standingProblems];
		if (mark.seq < this.droppedThrough) reasons.push("watch events were dropped because too many changes happened");
		for (const problem of this.problems) if (problem.seq > mark.seq) reasons.push(problem.reason);
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

	/** Reconciles the watched tree with disk; watchers also record intermediate states between command boundaries. */
	private scanTree(directory: string, recordFiles: boolean): void {
		const pending = [directory];
		const seen = new Set<string>();
		const scannedDirectories = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === undefined) continue;
			if (!this.watchers.has(current)) {
				if (this.watchers.size >= this.maxDirectories) {
					this.standingProblems.add(
						`more than ${this.maxDirectories} directories; changes under unwatched directories are not tracked`,
					);
					continue;
				}
				if (!this.watch(current)) continue;
			}
			let entries: string[];
			try {
				entries = readdirSync(current);
			} catch (error) {
				if (isMissingPath(error)) this.removeTree(current);
				else this.standingProblems.add(`cannot read directory ${current}`);
				continue;
			}
			scannedDirectories.add(current);
			for (const entry of entries) {
				const path = join(current, entry);
				seen.add(path);
				const state = this.statOf(path);
				if (state.kind === "missing") this.removeTree(path);
				if (state.kind !== "present" || state.stat.isSymbolicLink()) continue;
				const stat = state.stat;
				if (stat.isDirectory()) {
					if (!this.isExcluded(path)) pending.push(path);
				} else if (stat.isFile()) {
					this.observeFile(path, stat, recordFiles);
				}
			}
		}
		// An unreadable directory does not prove its children were deleted.
		for (const path of [...this.watchers.keys(), ...this.files.keys()]) {
			if (scannedDirectories.has(dirname(path)) && !seen.has(path)) this.removeTree(path);
		}
	}

	private statOf(path: string): PathState {
		try {
			return { kind: "present", stat: lstatSync(path, { bigint: true }) };
		} catch (error) {
			if (isMissingPath(error)) return { kind: "missing" };
			this.standingProblems.add(`cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`);
			return { kind: "unreadable" };
		}
	}

	private observeFile(path: string, stat: BigIntStats, record: boolean): void {
		const stamp = fileStamp(stat);
		if (this.files.get(path) === stamp) return;
		this.files.set(path, stamp);
		if (record) this.record(path);
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
		if (filename === basename(directory) && this.statOf(directory).kind === "missing") {
			this.removeTree(directory);
			return;
		}
		const path = join(directory, filename);
		const state = this.statOf(path);
		if (state.kind === "unreadable") return;
		if (state.kind === "missing") {
			this.removeTree(path);
			return;
		}
		const stat = state.stat;
		if (stat.isDirectory()) {
			if (!this.isExcluded(path)) this.scanTree(path, true);
			return;
		}
		if (stat.isFile()) {
			// Delayed startup events and duplicate notifications do not represent a new file state.
			this.observeFile(path, stat, true);
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
