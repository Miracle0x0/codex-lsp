#!/usr/bin/env node
// Scriptable LSP server for tests. Behaviour comes from FAKE_LSP_BEHAVIOR (JSON) and
// every received message is appended to FAKE_LSP_LOG (JSON lines) when set.
//
// Diagnostics: each line containing "ERROR" produces an error, "WARN" a warning.
// Behaviour keys:
//   capabilities           merged into the advertised ServerCapabilities
//   diagnosticMode         "push" (default) | "pull" | "none"
//   publishVersion         include the document version in publishDiagnostics (default true)
//   publishDelayMs         delay before publishing diagnostics
//   source                 diagnostic source string (default "fake")
//   requestDelays          { [method]: ms } delay before answering a request (cancellable)
//   exitOnRequest          method name that makes the process exit with code 3
//   renameEdit             WorkspaceEdit returned by textDocument/rename; "$NEW" becomes newName, "$ROOT" the root URI
//   publishOnce            publish at most once per document (a server that never refreshes)
//   skipUnchanged          on didChange, do not republish diagnostics equal to the last ones (like tsserver)
//   markers                markers this server reports (default ["ERROR", "WARN"])
//   loadingMs              after initialized, report work-done progress for this long; pulls return [] meanwhile
//   neverIdle              begin a work-done progress after initialized and never end it
//   backgroundCheck        { delayMs, durationMs }: after each change, run a progress-reported "check" that
//                          pushes diagnostics for lines containing "CHECK" (source "check")
//   clearOnClose           publish an empty result when a document closes (like typescript-language-server)
//   messageEnv             environment variable whose value is appended to every diagnostic message
//   hoverResult            value returned by textDocument/hover (default: markdown "fake hover")
//
// Call hierarchy: prepare returns "root" at the requested position; incoming/outgoing calls return one
// item named "<direction>-<depth>" whose data records the depth, so nested calls are observable.
import { appendFileSync } from "node:fs";
import { createMessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const behavior = JSON.parse(process.env.FAKE_LSP_BEHAVIOR ?? "{}");
const logPath = process.env.FAKE_LSP_LOG;
const documents = new Map();
let rootUri = "";
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

function log(entry) {
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function diagnosticsFor(text) {
	const diagnostics = [];
	const lines = text.split("\n");
	for (let line = 0; line < lines.length; line += 1) {
		const content = lines[line] ?? "";
		for (const [marker, severity] of [
			["ERROR", 1],
			["WARN", 2],
		].filter(([marker]) => (behavior.markers ?? ["ERROR", "WARN"]).includes(marker))) {
			const character = content.indexOf(marker);
			if (character === -1) continue;
			diagnostics.push({
				range: { start: { line, character }, end: { line, character: character + marker.length } },
				severity,
				code: `${marker.toLowerCase()}-code`,
				source: behavior.source ?? "fake",
				message: `${marker} marker on line ${line + 1}${behavior.messageEnv ? ` env=${process.env[behavior.messageEnv] ?? "(unset)"}` : ""}`,
			});
		}
	}
	return diagnostics;
}

const publishedOnce = new Set();
const lastPublished = new Map();

function publish(uri, reason) {
	if ((behavior.diagnosticMode ?? "push") !== "push") return;
	if (behavior.publishOnce) {
		if (publishedOnce.has(uri)) return;
		publishedOnce.add(uri);
	}
	const document = documents.get(uri);
	if (!document) return;
	const diagnostics = diagnosticsFor(document.text);
	const key = JSON.stringify(diagnostics);
	if (behavior.skipUnchanged && reason === "change" && lastPublished.get(uri) === key) return;
	lastPublished.set(uri, key);
	const send = () => {
		const params = { uri, diagnostics };
		if (behavior.publishVersion !== false) params.version = document.version;
		void connection.sendNotification("textDocument/publishDiagnostics", params);
	};
	if (behavior.publishDelayMs) setTimeout(send, behavior.publishDelayMs);
	else send();
}

function wait(ms, token) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		token.onCancellationRequested(() => {
			clearTimeout(timer);
			log({ kind: "cancelled" });
			reject(new ResponseError(-32800, "Request cancelled"));
		});
	});
}

function maybeExit(method) {
	if (behavior.exitOnRequest === method) process.exit(3);
}

async function delayFor(method, token) {
	const ms = behavior.requestDelays?.[method];
	if (ms) await wait(ms, token);
}

connection.onRequest("initialize", (params) => {
	log({ kind: "request", method: "initialize", params });
	maybeExit("initialize");
	rootUri = params.rootUri ?? "";
	const diagnosticProvider =
		behavior.diagnosticMode === "pull" ? { interFileDependencies: false, workspaceDiagnostics: false } : undefined;
	return {
		capabilities: {
			textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
			definitionProvider: true,
			referencesProvider: true,
			hoverProvider: true,
			implementationProvider: true,
			callHierarchyProvider: true,
			documentSymbolProvider: true,
			workspaceSymbolProvider: true,
			renameProvider: { prepareProvider: true },
			...(diagnosticProvider ? { diagnosticProvider } : {}),
			...(behavior.capabilities ?? {}),
		},
		serverInfo: { name: "fake-lsp", version: "1.0.0" },
	};
});

connection.onRequest("shutdown", () => {
	log({ kind: "request", method: "shutdown" });
	return null;
});

connection.onNotification("exit", () => {
	log({ kind: "notification", method: "exit" });
	process.exit(0);
});

let loading = false;
let progressTokens = 0;

async function progress(title, durationMs) {
	progressTokens += 1;
	const token = `fake-${progressTokens}`;
	// Like rust-analyzer: create and begin go out together, without waiting for the create response.
	void connection.sendRequest("window/workDoneProgress/create", { token });
	await connection.sendNotification("$/progress", { token, value: { kind: "begin", title } });
	if (durationMs === undefined) return;
	await new Promise((resolve) => setTimeout(resolve, durationMs));
	await connection.sendNotification("$/progress", { token, value: { kind: "end" } });
}

function checkDiagnostics(text) {
	const diagnostics = [];
	text.split("\n").forEach((content, line) => {
		const character = content.indexOf("CHECK");
		if (character === -1) return;
		diagnostics.push({
			range: { start: { line, character }, end: { line, character: character + 5 } },
			severity: 1,
			code: "check-code",
			source: "check",
			message: `CHECK marker on line ${line + 1}`,
		});
	});
	return diagnostics;
}

function backgroundCheck(uri) {
	const options = behavior.backgroundCheck;
	if (!options) return;
	setTimeout(async () => {
		const token = `check-${++progressTokens}`;
		void connection.sendRequest("window/workDoneProgress/create", { token });
		await connection.sendNotification("$/progress", { token, value: { kind: "begin", title: "check" } });
		await new Promise((resolve) => setTimeout(resolve, options.durationMs));
		const document = documents.get(uri);
		await connection.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics: checkDiagnostics(document?.text ?? "") });
		await connection.sendNotification("$/progress", { token, value: { kind: "end" } });
	}, options.delayMs);
}

connection.onNotification((method, params) => {
	log({ kind: "notification", method, params });
	if (method === "initialized") {
		if (behavior.loadingMs) {
			loading = true;
			void progress("loading", behavior.loadingMs).then(() => {
				loading = false;
			});
		}
		if (behavior.neverIdle) void progress("forever");
	}
	if (method === "textDocument/didOpen") {
		const { uri, version, text } = params.textDocument;
		documents.set(uri, { version, text });
		publish(uri, "open");
	} else if (method === "textDocument/didChange") {
		const { uri, version } = params.textDocument;
		const last = params.contentChanges.at(-1);
		documents.set(uri, { version, text: last?.text ?? documents.get(uri)?.text ?? "" });
		publish(uri, "change");
		backgroundCheck(uri);
	} else if (method === "textDocument/didClose") {
		documents.delete(params.textDocument.uri);
		lastPublished.delete(params.textDocument.uri);
		if (behavior.clearOnClose) void connection.sendNotification("textDocument/publishDiagnostics", { uri: params.textDocument.uri, diagnostics: [] });
	}
});

connection.onRequest("textDocument/diagnostic", (params) => {
	log({ kind: "request", method: "textDocument/diagnostic", params });
	maybeExit("textDocument/diagnostic");
	const document = documents.get(params.textDocument.uri);
	if (loading) return { kind: "full", resultId: "loading", items: [] };
	return { kind: "full", resultId: `r${document?.version ?? 0}`, items: diagnosticsFor(document?.text ?? "") };
});

connection.onRequest("textDocument/definition", async (params, token) => {
	log({ kind: "request", method: "textDocument/definition", params });
	maybeExit("textDocument/definition");
	await delayFor("textDocument/definition", token);
	return [{ uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }];
});

connection.onRequest("textDocument/references", (params) => {
	log({ kind: "request", method: "textDocument/references", params });
	return [{ uri: params.textDocument.uri, range: { start: params.position, end: params.position } }];
});

connection.onRequest("textDocument/hover", async (params, token) => {
	log({ kind: "request", method: "textDocument/hover", params });
	await delayFor("textDocument/hover", token);
	return behavior.hoverResult !== undefined ? behavior.hoverResult : { contents: { kind: "markdown", value: "fake hover" } };
});

connection.onRequest("textDocument/implementation", (params) => {
	log({ kind: "request", method: "textDocument/implementation", params });
	const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
	return [{ targetUri: params.textDocument.uri, targetRange: range, targetSelectionRange: range }];
});

function callItem(uri, name, line, data) {
	const range = { start: { line, character: 0 }, end: { line, character: name.length } };
	return { name, kind: 12, uri, range, selectionRange: range, data };
}

connection.onRequest("textDocument/prepareCallHierarchy", (params) => {
	log({ kind: "request", method: "textDocument/prepareCallHierarchy", params });
	return [callItem(params.textDocument.uri, "root", params.position.line, { depth: 0, token: "server-private" })];
});

for (const direction of ["incoming", "outgoing"]) {
	connection.onRequest(`callHierarchy/${direction}Calls`, (params) => {
		log({ kind: "request", method: `callHierarchy/${direction}Calls`, params });
		const depth = (params.item.data?.depth ?? 0) + 1;
		const item = callItem(params.item.uri, `${direction}-${depth}`, 0, { depth, token: "server-private" });
		const fromRanges = [{ start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }];
		return [direction === "incoming" ? { from: item, fromRanges } : { to: item, fromRanges }];
	});
}

connection.onRequest("textDocument/documentSymbol", (params) => {
	log({ kind: "request", method: "textDocument/documentSymbol", params });
	return [
		{
			name: "main",
			kind: 12,
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
			selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
		},
	];
});

connection.onRequest("workspace/symbol", (params) => {
	log({ kind: "request", method: "workspace/symbol", params });
	return [];
});

connection.onRequest("textDocument/prepareRename", (params) => {
	log({ kind: "request", method: "textDocument/prepareRename", params });
	return { range: { start: params.position, end: { line: params.position.line, character: params.position.character + 3 } }, placeholder: "old" };
});

connection.onRequest("textDocument/rename", (params) => {
	log({ kind: "request", method: "textDocument/rename", params });
	if (!behavior.renameEdit) return { changes: {} };
	return JSON.parse(JSON.stringify(behavior.renameEdit).replaceAll("$NEW", params.newName).replaceAll("$ROOT", rootUri));
});

connection.listen();
