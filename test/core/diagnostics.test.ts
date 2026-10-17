import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DiagnosticBatch } from "../../src/core/diagnostics/batch.js";
import { writeSnapshot } from "../../src/core/environment/snapshot.js";
import { createMcpHarness, type FakeLspBehavior, type HarnessOptions, type McpHarness } from "./helpers/mcp-harness.js";

const harnesses: McpHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function harness(behavior: FakeLspBehavior = {}, options: HarnessOptions = {}): Promise<McpHarness> {
	const created = await createMcpHarness(behavior, options);
	harnesses.push(created);
	return created;
}

async function diagnose(
	h: McpHarness,
	args: Record<string, unknown>,
): Promise<{ batch: DiagnosticBatch; isError: boolean }> {
	const result = await h.client.callTool({ name: "diagnostics", arguments: args });
	return { batch: result.structuredContent as DiagnosticBatch, isError: result.isError === true };
}

describe("multi-source diagnostics", () => {
	it("#given two diagnostic servers for one language #when checking a file #then both report with their own provider ids", async () => {
		// given
		const h = await harness({}, { extraServers: { lint: { diagnosticMode: "pull" } } });
		h.writeFile("a.fake", "ok\nERROR here\nWARN there\n");

		// when
		const { batch, isError } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(isError).toBe(false);
		expect(batch.complete).toBe(true);
		expect(batch.providers.map((provider) => [provider.serverId, provider.status, provider.mode])).toEqual([
			["fake", "ok", "push"],
			["lint", "ok", "pull"],
		]);
		expect(batch.counts).toMatchObject({ total: 4, error: 2, warning: 2 });
		const errors = batch.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		expect(errors.map((diagnostic) => [diagnostic.providerId, diagnostic.source, diagnostic.range.start])).toEqual([
			["fake", "fake", { line: 2, character: 0 }],
			["lint", "lint", { line: 2, character: 0 }],
		]);
	});

	it("#given two push providers #when one publishes an empty result #then only its own diagnostics are cleared", async () => {
		// given
		const h = await harness({}, { extraServers: { lint: { markers: ["WARN"] } } });
		h.writeFile("a.fake", "ERROR here\nWARN there\n");
		const before = await diagnose(h, { filePath: "a.fake" });

		// when
		h.writeFile("a.fake", "ERROR here\n");
		const { batch } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(before.batch.diagnostics.map((diagnostic) => diagnostic.providerId).sort()).toEqual([
			"fake",
			"fake",
			"lint",
		]);
		expect(batch.complete).toBe(true);
		expect(batch.diagnostics.map((diagnostic) => [diagnostic.providerId, diagnostic.severity])).toEqual([
			["fake", "error"],
		]);
		expect(batch.files.map((file) => [file.serverId, file.freshness])).toEqual([
			["fake", "confirmed"],
			["lint", "confirmed"],
		]);
	});

	it("#given one provider crashes #when checking #then the other provider's results stay and the batch is an incomplete error", async () => {
		// given
		const h = await harness({}, { extraServers: { broken: { exitOnRequest: "initialize" } } });
		h.writeFile("a.fake", "ERROR\n");

		// when
		const { batch, isError } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(isError).toBe(true);
		expect(batch.complete).toBe(false);
		expect(batch.providers.find((provider) => provider.serverId === "broken")?.status).toBe("failed");
		expect(batch.diagnostics.map((diagnostic) => diagnostic.providerId)).toEqual(["fake"]);
		expect(batch.incompleteReasons.join("\n")).toContain("broken");
	});

	it("#given a push server that never publishes #when checking #then the provider times out instead of reporting no diagnostics", async () => {
		// given
		const h = await harness({ diagnosticMode: "none" });
		h.writeFile("a.fake", "ERROR\n");

		// when
		const { batch, isError } = await diagnose(h, { filePath: "a.fake", timeoutMs: 300 });

		// then
		expect(isError).toBe(true);
		expect(batch.providers[0]).toMatchObject({ serverId: "fake", status: "timeout" });
		expect(batch.counts.total).toBe(0);
		expect(batch.complete).toBe(false);
	});

	it("#given an unchanged file #when checking twice #then the confirmed snapshot is reused without waiting", async () => {
		// given
		const h = await harness();
		h.writeFile("a.fake", "ERROR\n");
		await diagnose(h, { filePath: "a.fake" });

		// when
		const started = Date.now();
		const { batch } = await diagnose(h, { filePath: "a.fake", timeoutMs: 10_000 });

		// then
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(batch.files[0]?.freshness).toBe("confirmed");
		expect(batch.counts.error).toBe(1);
	});

	it("#given an edited file #when checking again #then diagnostics follow the new content and version", async () => {
		// given
		const h = await harness();
		h.writeFile("a.fake", "ERROR\n");
		await diagnose(h, { filePath: "a.fake" });

		// when
		h.writeFile("a.fake", "fixed\n");
		const { batch } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(batch.counts.total).toBe(0);
		expect(batch.files[0]).toMatchObject({ documentVersion: 2, freshness: "confirmed" });
	});

	it("#given a server that skips republishing unchanged results #when edits keep the diagnostics #then only the first edit waits", async () => {
		// given
		const h = await harness({ skipUnchanged: true, clearOnClose: true });
		h.writeFile("a.fake", "ERROR one\n");
		await diagnose(h, { filePath: "a.fake" });

		// when
		h.writeFile("a.fake", "ERROR one\n\n");
		const firstStart = performance.now();
		const first = await diagnose(h, { filePath: "a.fake" });
		const firstMs = performance.now() - firstStart;
		h.writeFile("a.fake", "ERROR one\n\n\n");
		const secondStart = performance.now();
		const second = await diagnose(h, { filePath: "a.fake" });
		const secondMs = performance.now() - secondStart;

		// then
		expect(first.batch.counts.error).toBe(1);
		expect(second.batch.counts.error).toBe(1);
		expect(second.batch.files[0]?.freshness).toBe("confirmed");
		expect(firstMs).toBeGreaterThanOrEqual(1_400);
		expect(secondMs).toBeLessThan(1_000);
	});

	it("#given a server that clears diagnostics on close #when a reopen nudge follows an edit that adds a problem #then the new problem is reported", async () => {
		// given
		const h = await harness({ skipUnchanged: true, clearOnClose: true });
		h.writeFile("a.fake", "ok\n");
		await diagnose(h, { filePath: "a.fake" });
		h.writeFile("a.fake", "ok\n\n");
		await diagnose(h, { filePath: "a.fake" });

		// when
		h.writeFile("a.fake", "ok\nERROR new\n");
		const { batch } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(batch.counts.error).toBe(1);
		expect(batch.files[0]?.freshness).toBe("confirmed");
	});

	it("#given another file changed #when the server never republishes #then the old result is marked unconfirmed", async () => {
		// given
		const h = await harness({ publishOnce: true });
		h.writeFile("a.fake", "ERROR\n");
		h.writeFile("b.fake", "fine\n");
		await diagnose(h, { filePath: "a.fake" });
		await diagnose(h, { filePath: "b.fake" });

		// when
		h.writeFile("b.fake", "changed\n");
		await diagnose(h, { filePath: "b.fake", timeoutMs: 500 });
		const { batch, isError } = await diagnose(h, { filePath: "a.fake", timeoutMs: 500 });

		// then
		expect(isError).toBe(false);
		expect(batch.files[0]?.freshness).toBe("unconfirmed");
		expect(batch.complete).toBe(false);
		expect(batch.counts.error).toBe(1);
	});

	it("#given unversioned publishes #when checking #then results are marked observed rather than confirmed", async () => {
		// given
		const h = await harness({ publishVersion: false });
		h.writeFile("a.fake", "WARN\n");

		// when
		const { batch } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(batch.files[0]?.freshness).toBe("observed");
		expect(batch.complete).toBe(true);
	});

	it("#given a minimum severity #when filtering #then counts and lists agree", async () => {
		// given
		const h = await harness();
		h.writeFile("a.fake", "ERROR\nWARN\n");

		// when
		const { batch } = await diagnose(h, { filePath: "a.fake", severity: "error" });

		// then
		expect(batch.minimumSeverity).toBe("error");
		expect(batch.counts).toMatchObject({ total: 1, error: 1, warning: 0 });
		expect(batch.diagnostics).toHaveLength(1);
	});

	it("#given a hint-level problem #when checking without a severity or config #then the explicit check reports hints", async () => {
		// given
		const h = await harness({ markers: ["ERROR", "HINT"] });
		h.writeFile("a.fake", "ERROR\nHINT\n");

		// when
		const { batch } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(batch.minimumSeverity).toBe("hint");
		expect(batch.counts).toMatchObject({ total: 2, error: 1, hint: 1 });
	});

	it("#given a single file no language claims #when checking it #then the tool fails instead of reporting coverage", async () => {
		// given
		const h = await harness();
		h.writeFile("notes.md", "# notes\n");

		// when
		const result = await h.client.callTool({ name: "diagnostics", arguments: { filePath: "notes.md" } });

		// then
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("[server_not_configured] No language is configured for '.md'");
		expect(h.readLog()).toEqual([]);
	});
});

describe("directory diagnostics", () => {
	it("#given more than fifty files and unsupported files #when checking a directory #then every file is checked and coverage is reported", async () => {
		// given
		const h = await harness();
		mkdirSync(join(h.workspace, "src", "node_modules"), { recursive: true });
		for (let index = 0; index < 60; index += 1)
			h.writeFile(join("src", `f${index}.fake`), index === 42 ? "ERROR\n" : "ok\n");
		h.writeFile(join("src", "notes.md"), "# notes\n");
		h.writeFile(join("src", "node_modules", "dep.fake"), "ERROR\n");

		// when
		const { batch } = await diagnose(h, { filePath: "src" });

		// then
		expect(batch.scope).toBe("directory");
		expect(batch.coverage).toMatchObject({
			scannedFiles: 61,
			checkedFiles: 60,
			unsupportedFiles: 1,
			unsupportedExtensions: [".md"],
			excludedDirectories: 1,
		});
		expect(batch.counts.error).toBe(1);
		expect(batch.diagnostics[0]?.path).toBe(join(h.workspace, "src", "f42.fake"));
		expect(batch.complete).toBe(true);
	});

	it("#given maxFiles #when the directory is larger #then the batch says files were left unscanned", async () => {
		// given
		const h = await harness();
		for (let index = 0; index < 5; index += 1) h.writeFile(`f${index}.fake`, "ok\n");

		// when
		const { batch } = await diagnose(h, { filePath: ".", maxFiles: 2 });

		// then
		expect(batch.coverage.scannedFiles).toBe(2);
		expect(batch.complete).toBe(false);
		expect(batch.incompleteReasons[0]).toContain("maxFiles=2");
	});
});

describe("environment-bound diagnostics", () => {
	function snapshot(stateDir: string, environmentId: string, mark: string): void {
		writeSnapshot(stateDir, {
			environmentId,
			kind: "shell",
			executionContextId: environmentId,
			cwd: "/",
			env: { ...process.env, FAKE_MARK: mark },
			extraVariables: ["FAKE_MARK"],
		});
	}

	it("#given two shells bound to different environments #when both check one file #then each gets its own client and results", async () => {
		// given
		const stateDir = mkdtempSync(join(tmpdir(), "lsp-env-state-"));
		directories.push(stateDir);
		snapshot(stateDir, "env-shell-a", "A");
		snapshot(stateDir, "env-shell-b", "B");
		const h = await harness({ messageEnv: "FAKE_MARK" }, { stateDir });
		h.writeFile("a.fake", "ERROR\n");

		// when
		const a = await diagnose(h, { filePath: "a.fake", environmentId: "env-shell-a" });
		const b = await diagnose(h, { filePath: "a.fake", environmentId: "env-shell-b" });

		// then
		expect(a.batch.environment).toMatchObject({
			environmentId: "env-shell-a",
			generation: 1,
			source: "shell-snapshot",
		});
		expect(a.batch.diagnostics[0]?.message).toContain("env=A");
		expect(b.batch.diagnostics[0]?.message).toContain("env=B");
		expect(h.runtime.manager.clientCount()).toBe(2);
	});

	it("#given a shell that changed its environment #when checking again #then the old client is replaced and results follow the new generation", async () => {
		// given
		const stateDir = mkdtempSync(join(tmpdir(), "lsp-env-state-"));
		directories.push(stateDir);
		snapshot(stateDir, "env-shell-a", "A1");
		const h = await harness({ messageEnv: "FAKE_MARK" }, { stateDir, defaultEnvironmentId: "env-shell-a" });
		h.writeFile("a.fake", "ERROR\n");
		await diagnose(h, { filePath: "a.fake" });

		// when
		snapshot(stateDir, "env-shell-a", "A2");
		const { batch } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(batch.environment.generation).toBe(2);
		expect(batch.diagnostics[0]?.message).toContain("env=A2");
		const states = h.runtime.manager.snapshot().map((client) => client.state);
		expect(states).toEqual(["ready"]);
	});

	it("#given an environment id with no snapshot #when checking #then the tool fails with environment_error", async () => {
		// given
		const stateDir = mkdtempSync(join(tmpdir(), "lsp-env-state-"));
		directories.push(stateDir);
		const h = await harness({}, { stateDir });
		h.writeFile("a.fake", "ERROR\n");

		// when
		const result = await h.client.callTool({
			name: "diagnostics",
			arguments: { filePath: "a.fake", environmentId: "env-not-there" },
		});

		// then
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("[environment_error]");
	});
});

describe("missing language servers", () => {
	const missingConfig = JSON.stringify({
		schemaVersion: 1,
		servers: { ghost: { command: ["lsp-tools-mcp-no-such-server"], installHint: "npm install -g ghost-ls" } },
		languages: { ghost: { extensions: [".ghost"], semanticServer: "ghost", diagnosticServers: ["ghost"] } },
	});

	it("#given a configured server that is not installed #when navigating #then the failure names it with the install hint", async () => {
		// given
		const h = await harness();
		h.writeFile("lsp-client.json", missingConfig);
		h.writeFile("a.ghost", "x\n");

		// when
		const result = await h.client.callTool({
			name: "goto_definition",
			arguments: { filePath: "a.ghost", line: 1, character: 0 },
		});

		// then
		expect(result.isError).toBe(true);
		const text = JSON.stringify(result.content);
		expect(text).toContain("[server_not_installed]");
		expect(text).toContain("npm install -g ghost-ls");
	});

	it("#given a diagnostic server that is not installed #when checking #then the provider is not_installed and the batch incomplete", async () => {
		// given
		const h = await harness();
		h.writeFile("lsp-client.json", missingConfig);
		h.writeFile("a.ghost", "x\n");

		// when
		const { batch, isError } = await diagnose(h, { filePath: "a.ghost" });

		// then
		expect(isError).toBe(true);
		expect(batch.complete).toBe(false);
		expect(batch.providers).toEqual([expect.objectContaining({ serverId: "ghost", status: "not_installed" })]);
		expect(batch.incompleteReasons.join("\n")).toContain("ghost-ls");
	});
});

describe("pull servers that report progress", () => {
	it("#given a server still loading its workspace #when the first check pulls #then it waits instead of reporting the empty early answer", async () => {
		// given
		const h = await harness({ diagnosticMode: "pull", loadingMs: 800 });
		h.writeFile("a.fake", "ERROR here\n");

		// when
		const { batch } = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(batch.counts.error).toBe(1);
		expect(batch.files[0]?.freshness).toBe("confirmed");
	});

	it("#given a background check that starts after an edit #when checking #then its pushed results are merged with the pull", async () => {
		// given
		// Like rust-analyzer: progress while loading, then a check about 100 ms after each change.
		const h = await harness({
			diagnosticMode: "pull",
			loadingMs: 200,
			backgroundCheck: { delayMs: 100, durationMs: 100 },
		});
		h.writeFile("a.fake", "ok\n");
		await diagnose(h, { filePath: "a.fake" });

		// when
		h.writeFile("a.fake", "ERROR pulled\nCHECK pushed\n");
		const added = await diagnose(h, { filePath: "a.fake" });
		h.writeFile("a.fake", "ok\n");
		const fixed = await diagnose(h, { filePath: "a.fake" });

		// then
		expect(added.batch.diagnostics.map((diagnostic) => diagnostic.source).sort()).toEqual(["check", "fake"]);
		expect(fixed.batch.counts.total).toBe(0);
	});

	it("#given a server that never goes idle #when checking twice #then both results remain incomplete", async () => {
		// given
		const h = await harness({ diagnosticMode: "pull", neverIdle: true });
		h.writeFile("a.fake", "ERROR here\n");

		// when
		const first = await diagnose(h, { filePath: "a.fake", timeoutMs: 600 });
		const second = await diagnose(h, { filePath: "a.fake", timeoutMs: 600 });

		// then
		expect(first.batch.counts.error).toBe(1);
		expect(first.batch.incompleteReasons.join("\n")).toContain("was still busy (forever)");
		expect(second.batch.counts.error).toBe(1);
		expect(second.batch.complete).toBe(false);
		expect(second.batch.files[0]?.freshness).toBe("unconfirmed");
		expect(second.batch.incompleteReasons.join("\n")).toContain("was still busy (forever)");
	});

	it("#given a loading timeout #when the next check allows loading to finish #then diagnostics recover", async () => {
		const h = await harness({ diagnosticMode: "pull", loadingMs: 900 });
		h.writeFile("a.fake", "ERROR here\n");
		const first = await diagnose(h, { filePath: "a.fake", timeoutMs: 100 });
		const second = await diagnose(h, { filePath: "a.fake", timeoutMs: 2000 });
		expect(first.batch.complete).toBe(false);
		expect(second.batch.complete).toBe(true);
		expect(second.batch.counts.error).toBe(1);
	});
});
