// Real processes for shutdown tests: delay replies, ignore TERM, or leave a worker behind.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const behavior = JSON.parse(process.env.SHUTDOWN_LSP_BEHAVIOR ?? "{}");
const log = (method) => appendFileSync(process.env.FAKE_LSP_LOG, `${JSON.stringify({ method, pid: process.pid })}\n`);

if (process.argv[2] === "worker") {
	if (behavior.workerIgnoreTerm) process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
	log("worker");
	process.send("ready");
} else {
	if (behavior.ignoreTerm) process.on("SIGTERM", () => log("SIGTERM"));
	// Keep a deliberately unresponsive server alive even after its owner loses the pipes.
	setInterval(() => {}, 1000);
	const ready = behavior.worker
		? new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker"], {
				stdio: ["ignore", behavior.workerInheritPipes ? "inherit" : "ignore", "ignore", "ipc"],
			});
			child.once("message", resolve);
			child.once("error", reject);
		})
		: Promise.resolve();
	const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
	connection.onRequest("initialize", async () => {
		await ready;
		log("initialize");
		if (behavior.initializeDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.initializeDelayMs));
		return { capabilities: { definitionProvider: true } };
	});
	connection.onRequest("textDocument/definition", () => {
		if (behavior.exitAfterDefinition) setTimeout(() => process.exit(0), 30);
		return null;
	});
	connection.onRequest("shutdown", async () => {
		log("shutdown");
		if (behavior.shutdownDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.shutdownDelayMs));
		return null;
	});
	connection.onNotification("exit", () => process.exit(0));
	connection.listen();
}
