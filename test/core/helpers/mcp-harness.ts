import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { PROJECT_CONFIG_ENV } from "../../../src/core/config/loader.js";
import { createLspServerFactory, type LspServerFactoryOptions } from "../../../src/core/mcp/server.js";
import { createLspRuntime, type LspRuntime } from "../../../src/core/runtime/runtime.js";
import { isolatedContext } from "../../support/context.js";

export const FAKE_SERVER_PATH = fileURLToPath(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url));

export interface FakeLspBehavior {
	readonly capabilities?: Record<string, unknown>;
	readonly diagnosticMode?: "push" | "pull" | "none";
	readonly publishVersion?: boolean;
	readonly publishDelayMs?: number;
	readonly source?: string;
	readonly requestDelays?: Record<string, number>;
	readonly exitOnRequest?: string;
	readonly exitOnNotification?: string;
	readonly cancelPulls?: { readonly times: number; readonly retrigger: boolean };
	readonly messageEnv?: string;
	readonly publishOnce?: boolean;
	readonly skipUnchanged?: boolean;
	readonly clearOnClose?: boolean;
	readonly loadingMs?: number;
	readonly neverIdle?: boolean;
	readonly backgroundCheck?: { readonly delayMs: number; readonly durationMs: number };
	readonly markers?: readonly ("ERROR" | "WARN" | "HINT")[];
	readonly renameEdit?: unknown;
	readonly hoverResult?: unknown;
}

export interface FakeLspLogEntry {
	readonly kind: string;
	readonly method?: string;
	readonly params?: unknown;
}

export interface McpHarness {
	readonly client: Client;
	readonly runtime: LspRuntime;
	readonly workspace: string;
	readonly logPath: string;
	writeFile(name: string, content: string): string;
	readLog(): FakeLspLogEntry[];
	close(): Promise<void>;
}

export interface HarnessOptions extends Omit<LspServerFactoryOptions, "version"> {
	/** null leaves the runtime without a default workspace root. */
	readonly defaultWorkspaceRoot?: string | null;
	/** Extra fake servers by id; the `.fake` language uses `fake` for semantics and these plus `fake` for diagnostics. */
	readonly extraServers?: Readonly<Record<string, FakeLspBehavior>>;
	readonly stateDir?: string;
	readonly defaultEnvironmentId?: string;
}

export function fakeServerConfig(id: string, behavior: FakeLspBehavior, logPath: string): Record<string, unknown> {
	return {
		command: [process.execPath, FAKE_SERVER_PATH],
		env: { FAKE_LSP_BEHAVIOR: JSON.stringify({ source: id, ...behavior }), FAKE_LSP_LOG: logPath },
	};
}

export async function createMcpHarness(
	behavior: FakeLspBehavior = {},
	options: HarnessOptions = {},
): Promise<McpHarness> {
	const context = isolatedContext("lsp-tools-mcp-test");
	const workspace = context.root;
	const logPath = join(workspace, "fake-lsp.log");
	const configPath = join(workspace, "lsp-client.json");
	const extra = options.extraServers ?? {};
	const servers: Record<string, unknown> = { fake: fakeServerConfig("fake", behavior, logPath) };
	for (const [id, extraBehavior] of Object.entries(extra)) servers[id] = fakeServerConfig(id, extraBehavior, logPath);
	writeFileSync(
		configPath,
		JSON.stringify({
			schemaVersion: 1,
			servers,
			languages: {
				fake: { extensions: [".fake"], semanticServer: "fake", diagnosticServers: ["fake", ...Object.keys(extra)] },
			},
		}),
	);

	const defaultWorkspaceRoot =
		options.defaultWorkspaceRoot === null ? undefined : (options.defaultWorkspaceRoot ?? workspace);
	const runtime = createLspRuntime({
		config: { env: { [PROJECT_CONFIG_ENV]: configPath }, homeDir: context.home },
		processEnv: context.env,
		...(defaultWorkspaceRoot === undefined ? {} : { defaultWorkspaceRoot }),
		...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
		...(options.defaultEnvironmentId === undefined ? {} : { defaultEnvironmentId: options.defaultEnvironmentId }),
	});
	const factoryOptions: Omit<LspServerFactoryOptions, "version"> = {
		...(options.tools === undefined ? {} : { tools: options.tools }),
		...(options.resolveContext === undefined ? {} : { resolveContext: options.resolveContext }),
	};
	const handler = createMcpHandler(createLspServerFactory(runtime, { ...factoryOptions, version: "0.0.0-test" }), {
		legacy: "reject",
	});
	const transport = new StreamableHTTPClientTransport(new URL("http://lsp.test/mcp"), {
		fetch: (url, init) => handler.fetch(new Request(url, init)),
	});
	const client = new Client(
		{ name: "lsp-tools-mcp-test", version: "0.0.0" },
		{ versionNegotiation: { mode: "auto" } },
	);
	await client.connect(transport);

	return {
		client,
		runtime,
		workspace,
		logPath,
		writeFile(name, content) {
			const path = join(workspace, name);
			writeFileSync(path, content);
			return path;
		},
		readLog() {
			if (!existsSync(logPath)) return [];
			return readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line): FakeLspLogEntry => JSON.parse(line));
		},
		async close() {
			await client.close();
			await handler.close();
			await runtime.dispose();
			context.cleanup();
		},
	};
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
