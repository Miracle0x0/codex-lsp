#!/usr/bin/env node
import { argv, stderr } from "node:process";

import { createLspRuntime, LSP_TOOLS, serveLspStdio } from "@code-yeongyu/lsp-tools-mcp";

import { resolveCodexContext } from "./codex-context.js";
import { runPostToolUseHookCli } from "./codex-hook.js";

async function serveMcp(): Promise<void> {
	// The plugin process starts in the plugin directory, so there is no default workspace root:
	// each call's workspace comes from Codex turn metadata or explicit tool arguments.
	const runtime = createLspRuntime();
	const handle = serveLspStdio(runtime, { tools: LSP_TOOLS, resolveContext: resolveCodexContext });
	const shutdown = async (): Promise<void> => {
		await handle.close();
		await runtime.dispose();
	};
	process.stdin.once("end", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
	const [command = "mcp", subcommand = ""] = argv.slice(2);

	if (command === "hook" && subcommand === "post-tool-use") {
		await runPostToolUseHookCli();
		return;
	}

	if (command === "mcp") {
		await serveMcp();
		return;
	}

	stderr.write("Usage: codex-lsp [mcp | hook post-tool-use]\n");
	process.exitCode = 2;
}

main().catch((error: unknown) => {
	stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
