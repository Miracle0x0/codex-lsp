#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { argv, cwd, env, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
	createLspRuntime,
	ENVIRONMENT_ID_PATTERN,
	LSP_TOOLS,
	manifestPath,
	type RegisteredLspTool,
	readManifest,
	serveLspStdio,
} from "@code-yeongyu/lsp-tools-mcp";

import { resolveCodexContext } from "./codex-context.js";
import { mcpConfigToml } from "./config-mcp.js";
import { captureStateDir, launchBinding } from "./environment/binding.js";
import { captureEnvironment } from "./environment/capture.js";
import { listEnvironments, removeEnvironment } from "./environment/manage.js";
import { type CliCommand, isShellName, SHELLS, shellInitScript } from "./environment/shell-init.js";
import { BaselineStore } from "./hook/baseline.js";
import { EditFeedback } from "./hook/edit-feedback.js";
import { postEditDiagnosticsTool, preEditSnapshotTool, recordingRename } from "./hook/tools.js";
import { launch } from "./launch.js";

const USAGE = `Usage:
  codex-lsp mcp                                  serve the MCP server (started by Codex)
  codex-lsp launch [codex arguments...]          capture this shell's environment and start Codex with it
  codex-lsp env capture [--kind shell|command] [--shell <name>]  snapshot this shell's environment; prints the environment id
  codex-lsp env shell-init <${SHELLS.join("|")}>          print shell integration to eval in your shell rc
  codex-lsp env list                             list captured environment metadata as JSON
  codex-lsp env remove <environment-id>           remove that environment's manifest and snapshots
  codex-lsp config mcp [--environment-id <id>]   print Codex config for using codex-lsp without the plugin
`;

class UsageError extends Error {
	override readonly name = "UsageError";
}

/** Absolute node and script paths; the real node path survives version-manager shims. */
function cliCommand(): CliCommand {
	return { node: realpathSync(process.execPath), script: fileURLToPath(import.meta.url) };
}

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

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
	return value;
}

function envCommand(args: readonly string[]): void {
	const [subcommand, ...rest] = args;
	if (subcommand === "list") {
		stdout.write(`${JSON.stringify(listEnvironments(captureStateDir(env)), null, 2)}\n`);
		return;
	}
	if (subcommand === "remove") {
		const id = rest[0];
		if (id === undefined || rest.length !== 1) throw new UsageError("env remove needs one environment id");
		removeEnvironment(captureStateDir(env), id);
		stdout.write(`Removed ${id}\n`);
		return;
	}
	if (subcommand === "capture") {
		const kind = option(rest, "--kind") ?? "command";
		if (kind !== "shell" && kind !== "command") throw new UsageError("--kind must be shell or command");
		const shellName = option(rest, "--shell");
		if (shellName !== undefined && !isShellName(shellName)) {
			throw new UsageError(`--shell must be one of: ${SHELLS.join(", ")}`);
		}
		const result = captureEnvironment({
			kind,
			stateDir: captureStateDir(env),
			env,
			cwd: cwd(),
			shellPid: process.ppid,
			...(shellName === undefined ? {} : { shellName }),
		});
		stdout.write(`${result.snapshot.environmentId}\n`);
		return;
	}
	if (subcommand === "shell-init") {
		const shell = rest[0] ?? "";
		if (!isShellName(shell)) throw new UsageError(`shell-init needs one of: ${SHELLS.join(", ")}`);
		stdout.write(shellInitScript(shell, cliCommand()));
		return;
	}
	throw new UsageError(`unknown env command: ${subcommand ?? "(none)"}`);
}

function configCommand(args: readonly string[]): void {
	const [subcommand, ...rest] = args;
	if (subcommand !== "mcp") throw new UsageError(`unknown config command: ${subcommand ?? "(none)"}`);
	const environmentId = option(rest, "--environment-id");
	let pinned: { environmentId: string; manifestPath: string } | undefined;
	if (environmentId !== undefined) {
		if (!ENVIRONMENT_ID_PATTERN.test(environmentId)) throw new UsageError(`invalid environment id: ${environmentId}`);
		const stateDir = captureStateDir(env);
		if (readManifest(stateDir, environmentId) === undefined) {
			throw new UsageError(`no captured environment ${environmentId} in ${stateDir}`);
		}
		pinned = { environmentId, manifestPath: manifestPath(stateDir, environmentId) };
	}
	stdout.write(
		mcpConfigToml({
			cli: cliCommand(),
			hooksPath: fileURLToPath(new URL("../hooks/hooks.json", import.meta.url)),
			...(pinned === undefined ? {} : { pinned }),
		}),
	);
}

async function main(): Promise<void> {
	const [command = "mcp", ...args] = argv.slice(2);
	switch (command) {
		case "mcp":
			await serveMcp();
			return;
		case "launch":
			process.exitCode = await launch({
				codexArgs: args[0] === "--" ? args.slice(1) : args,
				stateDir: captureStateDir(env),
				env,
				cwd: cwd(),
			});
			return;
		case "env":
			envCommand(args);
			return;
		case "config":
			configCommand(args);
			return;
		case "help":
		case "--help":
			stdout.write(USAGE);
			return;
		default:
			throw new UsageError(`unknown command: ${command}`);
	}
}

main().catch((error: unknown) => {
	if (error instanceof UsageError) {
		stderr.write(`codex-lsp: ${error.message}\n\n${USAGE}`);
		process.exitCode = 2;
		return;
	}
	stderr.write(`codex-lsp: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
