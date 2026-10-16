#!/usr/bin/env node
import { argv, env, stderr } from "node:process";

import { createLspRuntime, LSP_TOOLS, type RegisteredLspTool, serveLspStdio } from "@code-yeongyu/lsp-tools-mcp";

import { resolveCodexContext } from "./codex-context.js";
import { launchBinding } from "./environment-binding.js";
import { BaselineStore } from "./hook/baseline.js";
import { EditFeedback } from "./hook/edit-feedback.js";
import { postEditDiagnosticsTool, preEditSnapshotTool, recordingRename } from "./hook/tools.js";

async function serveMcp(): Promise<void> {
	const binding = launchBinding(env);
	for (const warning of binding.warnings) stderr.write(`codex-lsp: ${warning}\n`);
	// The plugin process starts in the plugin directory, so there is no default workspace root:
	// each call's workspace comes from Codex turn metadata, the hook's cwd, or explicit tool arguments.
	const runtime = createLspRuntime({
		stateDir: binding.stateDir,
		...(binding.environmentId === undefined ? {} : { defaultEnvironmentId: binding.environmentId }),
	});
	const baselines = new BaselineStore();
	const feedback = new EditFeedback(runtime, baselines);
	const tools: RegisteredLspTool[] = [
		...LSP_TOOLS.map((tool) => (tool.name === "rename" ? recordingRename(tool, baselines) : tool)),
		preEditSnapshotTool(feedback),
		postEditDiagnosticsTool(feedback),
	];
	const handle = serveLspStdio(runtime, { tools, resolveContext: resolveCodexContext });
	const shutdown = async (): Promise<void> => {
		await handle.close();
		await runtime.dispose();
	};
	process.stdin.once("end", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
	const [command = "mcp"] = argv.slice(2);
	if (command === "mcp") {
		await serveMcp();
		return;
	}
	stderr.write("Usage: codex-lsp mcp\n");
	process.exitCode = 2;
}

main().catch((error: unknown) => {
	stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
