import type { EffectiveServer } from "../../../src/core/config/loader.js";
import type { EnvironmentContext } from "../../../src/core/environment/service.js";
import { LspClient, type ServerTarget } from "../../../src/core/lsp/client.js";

export interface FakeLspClientOptions {
	readonly startDelayMs?: number;
	readonly failStart?: boolean;
}

/** LspClient without a process: start/stop are recorded so manager policies can be tested. */
export class FakeLspClient extends LspClient {
	private alive = false;
	startCallCount = 0;
	stopCallCount = 0;

	constructor(
		target: ServerTarget,
		private readonly options: FakeLspClientOptions = {},
	) {
		super(target);
	}

	override async start(): Promise<void> {
		this.startCallCount += 1;
		if (this.options.startDelayMs !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, this.options.startDelayMs));
		}
		if (this.options.failStart) throw new Error("fake start failed");
		this.alive = true;
		this.state = "ready";
	}

	override isAlive(): boolean {
		return this.alive;
	}

	kill(): void {
		this.alive = false;
	}

	override async stop(): Promise<void> {
		this.stopCallCount += 1;
		this.alive = false;
		this.state = "stopped";
	}
}

const UNBOUND: EnvironmentContext = {
	environmentId: null,
	generation: null,
	kind: null,
	source: "unbound",
	capturedAt: null,
	snapshotCwd: null,
	variables: {},
	notes: [],
	key: "unbound",
};

export function makeTarget(serverId: string, options: { slot?: string; key?: string } = {}): ServerTarget {
	const server: EffectiveServer = {
		id: serverId,
		source: "builtin",
		command: ["fake-server"],
		env: {},
		settings: {},
		initializationOptions: undefined,
		rootMarkers: [],
		installHint: undefined,
		hash: serverId,
	};
	const slot = options.slot ?? `unbound|/root|${serverId}`;
	return {
		key: options.key ?? `${slot}#1`,
		slot,
		server,
		executable: "/usr/bin/fake-server",
		args: [],
		projectRoot: "/root",
		workspaceRoot: "/root",
		environment: UNBOUND,
		toolchain: null,
		env: {},
		settings: {},
		initializationOptions: undefined,
	};
}
