import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
	ClientCapabilities,
	Diagnostic,
	InitializeResult,
	Registration,
	ServerCapabilities,
	TextDocumentSyncOptions,
} from "vscode-languageserver-protocol";

import type { EffectiveServer } from "../config/loader.js";
import type { EnvironmentContext } from "../environment/service.js";
import type { ToolchainResolution } from "../environment/toolchains/index.js";
import { reportBestEffortCleanupError } from "./cleanup-errors.js";
import { BARRIER_TIMEOUT_MS, INIT_TIMEOUT_MS, REQUEST_TIMEOUT_MS, STOP_REQUEST_TIMEOUT_MS } from "./constants.js";
import { matchesDocumentSelector } from "./document-selector.js";
import {
	LspConnectionClosedError,
	LspProcessExitedError,
	LspRequestCancelledError,
	LspRequestTimeoutError,
	LspServerStartError,
} from "./errors.js";
import { type SpawnedProcess, spawnProcess } from "./process.js";

const REQUEST_CANCELLED = -32800;
const STDERR_LINES = 100;

/** How a target's command was chosen. */
export interface ServerLaunch {
	/** "configured" runs the definition's own command; the others were chosen from the project's TypeScript SDK. */
	readonly backend: "configured" | "typescript-language-server" | "typescript-native";
	/** What the choice was based on, for status output. */
	readonly reason: string;
}

/** Everything needed to start one language server process for one environment and project. */
export interface ServerTarget {
	/** Client identity: changes when the server, environment variables, toolchain, or project root change. */
	readonly key: string;
	/** Environment + project + server; a new key in the same slot replaces the old client. */
	readonly slot: string;
	readonly server: EffectiveServer;
	readonly launch: ServerLaunch;
	readonly executable: string;
	readonly args: readonly string[];
	readonly projectRoot: string;
	readonly workspaceRoot: string | undefined;
	readonly environment: EnvironmentContext;
	readonly toolchain: ToolchainResolution | null;
	readonly env: Readonly<Record<string, string>>;
	readonly settings: Readonly<Record<string, unknown>>;
	readonly initializationOptions: Readonly<Record<string, unknown>> | undefined;
}

export interface PublishedDiagnostics {
	readonly uri: string;
	readonly version: number | null;
	readonly diagnostics: readonly Diagnostic[];
	readonly seq: number;
}

export interface OpenDocument {
	readonly uri: string;
	readonly path: string;
	readonly languageId: string;
	version: number;
	text: string;
	/** Sequence number of the last open/change notification sent for this document. */
	syncSeq: number;
}

export interface PullCacheEntry {
	readonly resultId: string | undefined;
	readonly diagnostics: readonly Diagnostic[];
}

export type ClientState = "starting" | "ready" | "failed" | "stopped";

export interface TextSyncBehavior {
	readonly openClose: boolean;
	/** 0 none, 1 full, 2 incremental; this client always sends full text. */
	readonly change: number;
	readonly save: boolean;
	readonly saveIncludesText: boolean;
}

const CLIENT_CAPABILITIES: ClientCapabilities = {
	general: { positionEncodings: ["utf-16"] },
	window: { workDoneProgress: true },
	// rust-analyzer reports workspace loading through experimental/serverStatus.
	experimental: { serverStatusNotification: true },
	workspace: {
		configuration: true,
		workspaceFolders: true,
		didChangeConfiguration: { dynamicRegistration: true },
		didChangeWatchedFiles: { dynamicRegistration: true },
		symbol: { dynamicRegistration: true },
		applyEdit: false,
		workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
		diagnostics: { refreshSupport: false },
	},
	textDocument: {
		synchronization: { dynamicRegistration: true, didSave: true, willSave: false, willSaveWaitUntil: false },
		publishDiagnostics: { relatedInformation: true, versionSupport: true, codeDescriptionSupport: true },
		diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
		hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
		definition: { dynamicRegistration: true, linkSupport: true },
		implementation: { dynamicRegistration: true, linkSupport: true },
		references: { dynamicRegistration: true },
		documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
		callHierarchy: { dynamicRegistration: true },
		rename: { dynamicRegistration: true, prepareSupport: true, prepareSupportDefaultBehavior: 1 },
	},
};

/** Bounds the whole handshake, including a blocked exit notification write. */
async function shutdownConnection(connection: MessageConnection): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			(async () => {
				await connection.sendRequest("shutdown");
				// On Windows taskkill needs the leader alive to find its descendants.
				if (process.platform !== "win32") await connection.sendNotification("exit");
			})(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("LSP shutdown handshake timed out")), STOP_REQUEST_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingAt(settings: Readonly<Record<string, unknown>>, section: string | undefined): unknown {
	if (section === undefined || section === "") return settings;
	let current: unknown = settings;
	for (const part of section.split(".")) {
		if (!isRecord(current)) return {};
		current = current[part];
	}
	return current ?? {};
}

function isDiagnosticArray(value: unknown): value is Diagnostic[] {
	return (
		Array.isArray(value) &&
		value.every((item) => isRecord(item) && isRecord(item["range"]) && typeof item["message"] === "string")
	);
}

export class LspClient {
	readonly instanceId = randomUUID();
	readonly documents = new Map<string, OpenDocument>();
	readonly pullCache = new Map<string, PullCacheEntry>();
	state: ClientState = "starting";
	readonly startedAt = Date.now();
	serverCapabilities: ServerCapabilities | null = null;
	serverInfo: { name: string; version?: string } | null = null;

	private proc: SpawnedProcess | null = null;
	private connection: MessageConnection | null = null;
	private stopping: Promise<void> | undefined;
	private readonly stderr: string[] = [];
	private readonly registrations = new Map<string, Registration>();
	private readonly published = new Map<string, PublishedDiagnostics>();
	private readonly publishListeners = new Set<(published: PublishedDiagnostics) => void>();
	private readonly registrationListeners = new Set<(method: string) => void>();
	private seq = 0;
	private workspaceChangeSeq = 0;
	/**
	 * Set once this server was seen to skip republishing a changed document whose diagnostics stayed the
	 * same (it published only after a reopen); later checks reopen right away instead of waiting.
	 */
	skipsUnchangedRepublish = false;
	private barrierUnsupported = false;
	/** Work-done progress the server began and has not ended, by token, with its title. */
	private readonly activeProgress = new Map<string | number, string>();
	/** From experimental/serverStatus; false while the server is still loading the workspace. */
	private quiescent: boolean | undefined;
	/** Set once the server reported any work-done progress or server status. */
	reportsProgress = false;
	private readonly busyListeners = new Set<() => void>();
	private exited = false;
	/** In-flight requests fail as soon as the process exits; jsonrpc alone would leave them pending. */
	private readonly exitListeners = new Set<() => void>();

	constructor(readonly target: ServerTarget) {}

	get pid(): number | undefined {
		return this.proc?.pid;
	}

	/** Spawns the server and completes the initialize handshake. */
	async start(signal?: AbortSignal): Promise<void> {
		const { target } = this;
		this.proc = spawnProcess([target.executable, ...target.args], {
			cwd: target.projectRoot,
			env: { ...target.env },
		});
		this.proc.stderr.setEncoding("utf-8");
		this.proc.stderr.on("data", (chunk: string) => {
			this.stderr.push(chunk);
			if (this.stderr.length > STDERR_LINES) this.stderr.shift();
		});
		void this.proc.exited.then(() => this.markExited());

		const connection = createMessageConnection(
			new StreamMessageReader(this.proc.stdout),
			new StreamMessageWriter(this.proc.stdin),
		);
		this.connection = connection;
		this.installHandlers(connection);
		connection.listen();

		const rootUri = pathToFileURL(target.projectRoot).href;
		let result: InitializeResult;
		try {
			result = await this.request<InitializeResult>(
				"initialize",
				{
					processId: process.pid,
					clientInfo: { name: "lsp-tools-mcp" },
					rootUri,
					rootPath: target.projectRoot,
					workspaceFolders: [{ uri: rootUri, name: target.projectRoot }],
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: target.initializationOptions,
				},
				signal,
				INIT_TIMEOUT_MS,
			);
		} catch (error) {
			this.state = "failed";
			if (error instanceof LspRequestCancelledError || error instanceof LspProcessExitedError) throw error;
			throw new LspServerStartError(
				target.server.id,
				target.projectRoot,
				error instanceof Error ? error.message : String(error),
				this.stderrTail(),
			);
		}
		this.serverCapabilities = result.capabilities;
		this.serverInfo = result.serverInfo ?? null;
		await this.notify("initialized", {});
		await this.notify("workspace/didChangeConfiguration", { settings: target.settings });
		this.state = "ready";
	}

	private installHandlers(connection: MessageConnection): void {
		connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
			if (!isRecord(params) || typeof params["uri"] !== "string" || !isDiagnosticArray(params["diagnostics"]))
				return;
			const published: PublishedDiagnostics = {
				uri: params["uri"],
				version: typeof params["version"] === "number" ? params["version"] : null,
				diagnostics: params["diagnostics"],
				seq: this.nextSeq(),
			};
			this.published.set(published.uri, published);
			for (const listener of this.publishListeners) listener(published);
		});
		connection.onNotification("window/logMessage", () => undefined);
		connection.onNotification("window/showMessage", () => undefined);
		connection.onNotification("$/progress", (params: unknown) => {
			if (!isRecord(params) || !isRecord(params["value"])) return;
			const token = params["token"];
			if (typeof token !== "string" && typeof token !== "number") return;
			const value = params["value"];
			if (value["kind"] === "begin") {
				this.reportsProgress = true;
				this.activeProgress.set(token, typeof value["title"] === "string" ? value["title"] : String(token));
			} else if (value["kind"] === "end") {
				this.activeProgress.delete(token);
			} else {
				return;
			}
			for (const listener of this.busyListeners) listener();
		});
		connection.onNotification("experimental/serverStatus", (params: unknown) => {
			if (!isRecord(params) || typeof params["quiescent"] !== "boolean") return;
			this.quiescent = params["quiescent"];
			this.reportsProgress = true;
			for (const listener of this.busyListeners) listener();
		});
		connection.onNotification("telemetry/event", () => undefined);
		connection.onRequest("workspace/configuration", (params: unknown) => {
			const items = isRecord(params) && Array.isArray(params["items"]) ? params["items"] : [];
			return items.map((item: unknown) =>
				settingAt(
					this.target.settings,
					isRecord(item) && typeof item["section"] === "string" ? item["section"] : undefined,
				),
			);
		});
		connection.onRequest("workspace/workspaceFolders", () => {
			const uri = pathToFileURL(this.target.projectRoot).href;
			return [{ uri, name: this.target.projectRoot }];
		});
		connection.onRequest("client/registerCapability", (params: unknown) => {
			const registrations =
				isRecord(params) && Array.isArray(params["registrations"]) ? params["registrations"] : [];
			for (const registration of registrations) {
				if (
					isRecord(registration) &&
					typeof registration["id"] === "string" &&
					typeof registration["method"] === "string"
				) {
					const method = registration["method"];
					this.registrations.set(registration["id"], {
						id: registration["id"],
						method,
						registerOptions: registration["registerOptions"],
					});
					for (const listener of this.registrationListeners) listener(method);
				}
			}
			return null;
		});
		connection.onRequest("client/unregisterCapability", (params: unknown) => {
			const removals =
				isRecord(params) && Array.isArray(params["unregisterations"]) ? params["unregisterations"] : [];
			for (const removal of removals) {
				if (isRecord(removal) && typeof removal["id"] === "string") this.registrations.delete(removal["id"]);
			}
			return null;
		});
		connection.onRequest("window/workDoneProgress/create", () => null);
		connection.onRequest("window/showMessageRequest", () => null);
		connection.onRequest("workspace/applyEdit", () => ({
			applied: false,
			failureReason: "lsp-tools-mcp applies edits only through its own rename tool",
		}));
		connection.onRequest("workspace/diagnostic/refresh", () => null);
		connection.onClose(() => this.markExited());
		connection.onError(([error]) => reportBestEffortCleanupError("connection error notification", error));
	}

	private markExited(): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of this.exitListeners) listener();
		this.exitListeners.clear();
	}

	nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	/** Records that some workspace file changed; earlier pushed diagnostics may now be stale. */
	markWorkspaceChange(): void {
		this.workspaceChangeSeq = this.nextSeq();
	}

	get lastWorkspaceChange(): number {
		return this.workspaceChangeSeq;
	}

	/** What the server reports it is still working on; empty when it is idle. */
	busyWith(): string[] {
		const reasons = [...new Set(this.activeProgress.values())];
		if (this.quiescent === false) reasons.push("loading the workspace");
		return reasons;
	}

	/** Resolves true once the server reports no pending work, or false when `timeoutMs` passes first. */
	waitUntilIdle(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		return this.waitForBusy(false, timeoutMs, signal);
	}

	/** Resolves true when the server starts reporting work within `timeoutMs`, else false. */
	waitUntilBusy(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		return this.waitForBusy(true, timeoutMs, signal);
	}

	private waitForBusy(busy: boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		const reached = (): boolean => this.busyWith().length > 0 === busy;
		if (reached()) return Promise.resolve(true);
		return this.wait({
			what: "waiting for the server to finish loading",
			timeoutMs,
			signal,
			onTimeout: () => false,
			subscribe: (settle) => {
				const onChange = (): void => {
					if (reached()) settle(true);
				};
				this.busyListeners.add(onChange);
				return () => this.busyListeners.delete(onChange);
			},
		});
	}

	latestPublished(uri: string): PublishedDiagnostics | undefined {
		return this.published.get(uri);
	}

	/**
	 * Resolves with the first publish for `uri` that satisfies `accept`, "pull" when the server registers
	 * pull diagnostics meanwhile (servers that do stop pushing), or null on timeout.
	 */
	waitForPublish(
		uri: string,
		accept: (published: PublishedDiagnostics) => boolean,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<PublishedDiagnostics | "pull" | null> {
		const current = this.published.get(uri);
		if (current !== undefined && accept(current)) return Promise.resolve(current);
		return this.wait<PublishedDiagnostics | "pull" | null>({
			what: "textDocument/publishDiagnostics",
			timeoutMs,
			signal,
			onTimeout: () => null,
			subscribe: (settle) => {
				const onPublish = (published: PublishedDiagnostics): void => {
					if (published.uri === uri && accept(published)) settle(published);
				};
				const onRegistration = (method: string): void => {
					if (method === "textDocument/diagnostic") settle("pull");
				};
				this.publishListeners.add(onPublish);
				this.registrationListeners.add(onRegistration);
				return () => {
					this.publishListeners.delete(onPublish);
					this.registrationListeners.delete(onRegistration);
				};
			},
		});
	}

	/**
	 * One wait on this client. Whatever ends it (the awaited event, a failure, the timeout, cancellation, or
	 * the server exiting) removes every listener and timer the wait registered. Cancellation and exit reject,
	 * including when they happened before the wait began; the timeout's outcome comes from `onTimeout`.
	 */
	private wait<T>(spec: {
		readonly what: string;
		readonly timeoutMs: number;
		readonly signal: AbortSignal | undefined;
		readonly onTimeout: () => T;
		/** Runs when the timeout or cancellation ends the wait, for example to cancel a request. */
		readonly onInterrupt?: () => void;
		readonly subscribe: (settle: (value: T) => void, fail: (error: unknown) => void) => () => void;
	}): Promise<T> {
		if (this.exited) return Promise.reject(this.exitedError());
		if (spec.signal?.aborted) return Promise.reject(new LspRequestCancelledError(spec.what));
		return new Promise<T>((resolve, reject) => {
			let done = false;
			let unsubscribe: () => void = () => undefined;
			const finish = (outcome: () => void): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.exitListeners.delete(onExit);
				spec.signal?.removeEventListener("abort", onAbort);
				unsubscribe();
				outcome();
			};
			const onExit = (): void => finish(() => reject(this.exitedError()));
			const onAbort = (): void =>
				finish(() => {
					spec.onInterrupt?.();
					reject(new LspRequestCancelledError(spec.what));
				});
			const timer = setTimeout(
				() =>
					finish(() => {
						spec.onInterrupt?.();
						try {
							resolve(spec.onTimeout());
						} catch (error) {
							reject(error);
						}
					}),
				spec.timeoutMs,
			);
			this.exitListeners.add(onExit);
			spec.signal?.addEventListener("abort", onAbort, { once: true });
			const teardown = spec.subscribe(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
			if (done) teardown();
			else unsubscribe = teardown;
		});
	}

	private hasRegistration(method: string): boolean {
		for (const registration of this.registrations.values()) if (registration.method === method) return true;
		return false;
	}

	/** Static capability or a dynamic registration for the method. */
	supports(capability: keyof ServerCapabilities, method: string): boolean {
		const value = this.serverCapabilities?.[capability];
		return (value !== undefined && value !== false && value !== null) || this.hasRegistration(method);
	}

	supportsPullDiagnostics(): boolean {
		return this.supports("diagnosticProvider", "textDocument/diagnostic");
	}

	watchesFiles(): boolean {
		return this.hasRegistration("workspace/didChangeWatchedFiles");
	}

	/** Sync behaviour for a document: static textDocumentSync plus dynamically registered didSave. */
	textSync(document: { readonly path: string; readonly languageId: string }): TextSyncBehavior {
		const sync = this.serverCapabilities?.textDocumentSync;
		const options: TextDocumentSyncOptions =
			typeof sync === "number" ? { openClose: true, change: sync } : (sync ?? {});
		const save = options.save;
		let saves = save !== undefined && save !== false;
		let saveIncludesText = typeof save === "object" && save.includeText === true;
		for (const registration of this.registrations.values()) {
			if (registration.method !== "textDocument/didSave") continue;
			const registerOptions: unknown = registration.registerOptions;
			const record = isRecord(registerOptions) ? registerOptions : {};
			if (!matchesDocumentSelector(record["documentSelector"], document)) continue;
			saves = true;
			saveIncludesText ||= record["includeText"] === true;
		}
		return { openClose: options.openClose ?? true, change: options.change ?? 0, save: saves, saveIncludesText };
	}

	isAlive(): boolean {
		return this.proc !== null && !this.exited && this.proc.exitCode === null && this.state !== "stopped";
	}

	stderrTail(lines = 10): string | undefined {
		const tail = this.stderr.slice(-lines).join("");
		return tail.trim() ? tail.slice(-2000) : undefined;
	}

	private exitedError(): LspProcessExitedError {
		return new LspProcessExitedError(
			this.target.server.id,
			this.target.projectRoot,
			this.proc?.exitCode ?? null,
			this.stderrTail(),
		);
	}

	/**
	 * Resolves once the server answered a request sent after everything before it, so notifications it
	 * emitted while handling earlier messages have arrived. LSP requires unknown `$/` requests to fail
	 * with MethodNotFound; a server that never answers is not asked again.
	 */
	async barrier(): Promise<void> {
		if (this.barrierUnsupported) return;
		try {
			await this.request("$/lspToolsMcp/barrier", {}, undefined, BARRIER_TIMEOUT_MS);
		} catch (error) {
			if (error instanceof ResponseError) return;
			if (error instanceof LspRequestTimeoutError) {
				this.barrierUnsupported = true;
				return;
			}
			throw error;
		}
	}

	async request<T>(method: string, params: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
		const connection = this.connection;
		if (!connection) throw new Error("LSP client not started");
		const cancellation = new CancellationTokenSource();
		try {
			return await this.wait<T>({
				what: method,
				timeoutMs,
				signal,
				onTimeout: () => {
					throw new LspRequestTimeoutError(method, this.stderrTail(5));
				},
				onInterrupt: () => cancellation.cancel(),
				subscribe: (settle, fail) => {
					const pending =
						params === undefined
							? connection.sendRequest<T>(method, cancellation.token)
							: connection.sendRequest<T>(method, params, cancellation.token);
					pending.then(settle, (error: unknown) => fail(this.requestError(method, error)));
					return () => undefined;
				},
			});
		} finally {
			cancellation.dispose();
		}
	}

	private requestError(method: string, error: unknown): unknown {
		if (error instanceof ResponseError && error.code === REQUEST_CANCELLED)
			return new LspRequestCancelledError(method);
		if (this.exited || (this.proc !== null && this.proc.exitCode !== null)) return this.exitedError();
		if (
			error instanceof Error &&
			/connection (?:is )?(?:closed|disposed)|pending response rejected/i.test(error.message)
		) {
			return new LspConnectionClosedError(this.target.server.id, this.target.projectRoot, error.message);
		}
		return error;
	}

	async notify(method: string, params: unknown): Promise<void> {
		const connection = this.connection;
		if (!connection || this.exited) return;
		try {
			await connection.sendNotification(method, params);
		} catch (error) {
			throw new LspConnectionClosedError(
				this.target.server.id,
				this.target.projectRoot,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	stop(): Promise<void> {
		this.stopping ??= this.stopClient();
		return this.stopping;
	}

	private async stopClient(): Promise<void> {
		this.state = "stopped";
		const connection = this.connection;
		if (connection && !this.exited) {
			try {
				await shutdownConnection(connection);
			} catch (error) {
				reportBestEffortCleanupError("shutdown request", error);
			}
		}
		if (connection) {
			try {
				connection.dispose();
			} catch (error) {
				reportBestEffortCleanupError("connection dispose", error);
			}
			this.connection = null;
		}
		await this.proc?.terminate();
		this.markExited();
		this.documents.clear();
		this.published.clear();
		this.pullCache.clear();
	}
}
