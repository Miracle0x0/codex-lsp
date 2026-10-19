import { reportBestEffortCleanupError } from "./cleanup-errors.js";
import { LspClient, type ServerTarget } from "./client.js";
import { IDLE_TIMEOUT_MS, INIT_TIMEOUT_MS, REAPER_INTERVAL_MS } from "./constants.js";
import { isLspDeadConnectionError } from "./errors.js";

interface ManagedClient {
	readonly client: LspClient;
	refCount: number;
	pendingWaiters: number;
	lastUsedAt: number;
	initPromise: Promise<void> | null;
	initializingSince: number | null;
	/** Replaced by a client for a newer environment or toolchain; stopped once released. */
	retired: boolean;
}

export interface ClientSnapshot {
	readonly key: string;
	readonly serverId: string;
	readonly projectRoot: string;
	readonly backend: ServerTarget["launch"]["backend"];
	/** Why this command was chosen. */
	readonly launch: string;
	readonly environmentId: string | null;
	readonly environmentGeneration: number | null;
	readonly environmentSource: string;
	readonly executable: string;
	readonly toolchain: string | null;
	readonly serverInfo: string | null;
	readonly state: "initializing" | "ready" | "dead" | "retired";
	readonly refCount: number;
	readonly openDocuments: number;
	readonly pid: number | undefined;
}

export interface LspManagerOptions {
	readonly idleTimeoutMs?: number;
	readonly initTimeoutMs?: number;
	readonly reaperIntervalMs?: number;
	readonly clientFactory?: (target: ServerTarget) => LspClient;
	readonly now?: () => number;
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new DOMException("Aborted", "AbortError"));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Owns every language server process; tools borrow clients through `withClient`. Process exit is the
 * entry point's concern: it calls `stopAll` (through `LspRuntime.dispose`) on shutdown.
 */
export class LspManager {
	private readonly clients = new Map<string, ManagedClient>();
	private readonly stopping = new Map<LspClient, Promise<void>>();
	private stopAllPromise: Promise<void> | undefined;
	private reaperHandle: NodeJS.Timeout | null = null;
	private disposed = false;
	private readonly idleTimeoutMs: number;
	private readonly initTimeoutMs: number;
	private readonly clientFactory: (target: ServerTarget) => LspClient;
	private readonly now: () => number;

	constructor(options: LspManagerOptions = {}) {
		this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
		this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
		this.clientFactory = options.clientFactory ?? ((target) => new LspClient(target));
		this.now = options.now ?? (() => Date.now());
		this.reaperHandle = setInterval(() => this.reapStale(), options.reaperIntervalMs ?? REAPER_INTERVAL_MS);
		this.reaperHandle.unref();
	}

	/** Retain pending and failed stops after their client leaves the reusable pool. */
	private stop(client: LspClient): Promise<void> {
		const existing = this.stopping.get(client);
		if (existing) return existing;
		const stopping = client.stop();
		this.stopping.set(client, stopping);
		void stopping.then(
			() => this.stopping.delete(client),
			(error: unknown) => reportBestEffortCleanupError(`stop ${client.target.server.id}`, error),
		);
		return stopping;
	}

	private reapStale(): void {
		const now = this.now();
		for (const [key, managed] of this.clients) {
			const initExpired = managed.initializingSince !== null && now - managed.initializingSince > this.initTimeoutMs;
			const idle =
				managed.initPromise === null &&
				managed.refCount === 0 &&
				managed.pendingWaiters === 0 &&
				now - managed.lastUsedAt > this.idleTimeoutMs;
			if (initExpired || idle) {
				this.clients.delete(key);
				void this.stop(managed.client);
			}
		}
	}

	private retireSlot(target: ServerTarget): void {
		for (const [key, managed] of this.clients) {
			if (key === target.key || managed.client.target.slot !== target.slot) continue;
			managed.retired = true;
			if (managed.refCount === 0 && managed.pendingWaiters === 0) {
				this.clients.delete(key);
				void this.stop(managed.client);
			}
		}
	}

	async acquire(target: ServerTarget, signal?: AbortSignal): Promise<LspClient> {
		if (this.disposed) throw new Error("LspManager has been disposed");
		signal?.throwIfAborted();
		const existing = this.clients.get(target.key);
		if (existing) {
			if (existing.initPromise) {
				existing.pendingWaiters += 1;
				try {
					await awaitWithSignal(existing.initPromise, signal);
				} finally {
					existing.pendingWaiters -= 1;
				}
			}
			if (this.disposed) throw new Error("LspManager has been disposed");
			if (!existing.client.isAlive()) {
				if (this.clients.get(target.key) === existing) this.clients.delete(target.key);
				await this.stop(existing.client);
				return this.acquire(target, signal);
			}
			existing.refCount += 1;
			existing.lastUsedAt = this.now();
			return existing.client;
		}

		this.retireSlot(target);
		const client = this.clientFactory(target);
		const managed: ManagedClient = {
			client,
			refCount: 0,
			pendingWaiters: 1,
			lastUsedAt: this.now(),
			initPromise: null,
			initializingSince: this.now(),
			retired: false,
		};
		managed.initPromise = client.start();
		this.clients.set(target.key, managed);
		try {
			await awaitWithSignal(managed.initPromise, signal);
			if (this.disposed) throw new Error("LspManager has been disposed");
		} catch (error) {
			managed.pendingWaiters -= 1;
			if (this.clients.get(target.key) === managed) this.clients.delete(target.key);
			await this.stop(client);
			throw error;
		}
		managed.pendingWaiters -= 1;
		managed.initPromise = null;
		managed.initializingSince = null;
		managed.refCount += 1;
		managed.lastUsedAt = this.now();
		return client;
	}

	release(client: LspClient): void {
		const managed = this.clients.get(client.target.key);
		if (!managed || managed.client !== client) return;
		if (managed.refCount > 0) managed.refCount -= 1;
		managed.lastUsedAt = this.now();
		if (managed.retired && managed.refCount === 0 && managed.pendingWaiters === 0) {
			this.clients.delete(client.target.key);
			void this.stop(client);
		}
	}

	invalidate(client: LspClient): void {
		const managed = this.clients.get(client.target.key);
		if (!managed || managed.client !== client) return;
		this.clients.delete(client.target.key);
		void this.stop(client);
	}

	/**
	 * Borrows a client for one operation. Read-only operations retry once on a fresh client when the
	 * server process died mid-request; writes never retry.
	 */
	async withClient<T>(
		target: ServerTarget,
		operation: (client: LspClient) => Promise<T>,
		options: { readonly signal?: AbortSignal; readonly readOnly: boolean },
	): Promise<T> {
		const run = async (allowRetry: boolean): Promise<T> => {
			const client = await this.acquire(target, options.signal);
			try {
				return await operation(client);
			} catch (error) {
				if (allowRetry && options.readOnly && isLspDeadConnectionError(error)) {
					this.invalidate(client);
					return run(false);
				}
				throw error;
			} finally {
				this.release(client);
			}
		};
		return run(true);
	}

	/** Ready, non-retired clients; used to broadcast file changes. */
	activeClients(): LspClient[] {
		const result: LspClient[] = [];
		for (const managed of this.clients.values()) {
			if (managed.initPromise === null && !managed.retired && managed.client.isAlive()) result.push(managed.client);
		}
		return result;
	}

	clientCount(): number {
		return this.clients.size;
	}

	snapshot(): ClientSnapshot[] {
		return [...this.clients.values()].map(({ client, refCount, initPromise, retired }) => {
			const { target } = client;
			return {
				key: target.key,
				serverId: target.server.id,
				projectRoot: target.projectRoot,
				backend: target.launch.backend,
				launch: target.launch.reason,
				environmentId: target.environment.environmentId,
				environmentGeneration: target.environment.generation,
				environmentSource: target.environment.source,
				executable: target.executable,
				toolchain: target.toolchain?.summary ?? null,
				serverInfo: client.serverInfo
					? `${client.serverInfo.name}${client.serverInfo.version ? ` ${client.serverInfo.version}` : ""}`
					: null,
				state: retired ? "retired" : initPromise ? "initializing" : client.isAlive() ? "ready" : "dead",
				refCount,
				openDocuments: client.documents.size,
				pid: client.pid,
			};
		});
	}

	/** Stops every client; rejects after all were attempted when any failed to stop. */
	stopAll(): Promise<void> {
		this.stopAllPromise ??= this.stopAllClients();
		return this.stopAllPromise;
	}

	private async stopAllClients(): Promise<void> {
		this.disposed = true;
		if (this.reaperHandle) {
			clearInterval(this.reaperHandle);
			this.reaperHandle = null;
		}
		for (const { client } of this.clients.values()) void this.stop(client);
		this.clients.clear();
		const stops = [...this.stopping];
		// Includes clients already being retired, invalidated, or reaped before shutdown began.
		const results = await Promise.allSettled(stops.map(([, stopping]) => stopping));
		const failures = results.flatMap((result, index) =>
			result.status === "rejected"
				? [
						`${stops[index]?.[0].target.server.id ?? "?"}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
					]
				: [],
		);
		this.stopping.clear();
		if (failures.length > 0) throw new Error(`Failed to stop language servers:\n  ${failures.join("\n  ")}`);
	}
}
