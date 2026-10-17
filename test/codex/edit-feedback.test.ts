import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BaselineStore } from "../../src/codex/hook/baseline.js";
import { EditFeedback } from "../../src/codex/hook/edit-feedback.js";
import { postEditDiagnosticsTool, preEditSnapshotTool } from "../../src/codex/hook/tools.js";
import { createLspRuntime } from "../../src/core/index.js";
import { FileChangeJournal } from "../../src/core/workspace/journal.js";

it("#given an old problem #when the provider returns an unconfirmed empty result #then no resolution is claimed and the baseline survives", async () => {
	const root = mkdtempSync(join(tmpdir(), "lsp-hook-freshness-"));
	const path = join(root, "a.py");
	writeFileSync(path, "x = 1\n");
	const runtime = createLspRuntime({ config: { env: {}, homeDir: root } });
	const baselines = new BaselineStore();
	baselines.set("session", path, {
		environmentKey: "unbound:-#-",
		contentHash: null,
		providers: ["pyright"],
		diagnostics: [
			{
				path,
				providerId: "pyright",
				severity: "error",
				message: "old error",
				range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
			},
		],
	});
	vi.spyOn(runtime.diagnostics, "runProvider").mockImplementation(async (serverId, files) => ({
		serverId,
		status: "ok",
		mode: "pull",
		message: undefined,
		filesChecked: files.length,
		results: files.map((file) => ({
			file,
			serverId,
			freshness: "unconfirmed",
			unconfirmedReason: "still loading",
			documentVersion: 1,
			diagnostics: [],
			documentText: "x = 1\n",
		})),
	}));
	try {
		const result = await postEditDiagnosticsTool(new EditFeedback(runtime, baselines)).run(
			runtime,
			{
				sessionId: "session",
				toolUseId: "patch",
				cwd: root,
				toolName: "apply_patch",
				toolInput: { command: `*** Begin Patch\n*** Update File: ${path}\n@@\n*** End Patch` },
				toolResponse: "Exit code: 0",
			},
			{ signal: new AbortController().signal },
		);
		expect(result.summary).toContain("still loading");
		expect(result.summary).not.toContain("resolved");
		expect(baselines.get("session", path)?.diagnostics).toHaveLength(1);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

it("#given an incomplete watcher with no recorded changes #when hooks run twice #then both report the missing coverage", async () => {
	const root = mkdtempSync(join(tmpdir(), "lsp-hook-coverage-"));
	mkdirSync(join(root, "unwatched"));
	const journal = new FileChangeJournal(root, { exclude: [], maxDirectories: 1, drainMs: 0 });
	const runtime = createLspRuntime({ config: { env: {}, homeDir: root } });
	vi.spyOn(runtime, "journal").mockReturnValue(journal);
	const feedback = new EditFeedback(runtime, new BaselineStore());
	const context = { signal: new AbortController().signal };
	try {
		for (const id of ["first", "second"]) {
			const event = {
				sessionId: "session",
				toolUseId: id,
				cwd: root,
				toolName: "Bash",
				toolInput: { command: "true" },
			};
			await preEditSnapshotTool(feedback).run(runtime, event, context);
			const result = await postEditDiagnosticsTool(feedback).run(runtime, { ...event, toolResponse: "" }, context);
			expect(result.summary).toContain("File changes may be incomplete");
			expect(result.summary).toContain("unwatched directories");
		}
	} finally {
		journal.close();
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

it("#given a hint and no configured severity #when an edit is checked #then the hook reports from warnings up", async () => {
	const root = mkdtempSync(join(tmpdir(), "lsp-hook-severity-"));
	const path = join(root, "a.py");
	const runtime = createLspRuntime({ config: { env: {}, homeDir: root } });
	vi.spyOn(runtime.diagnostics, "runProvider").mockImplementation(async (serverId, files) => ({
		serverId,
		status: "ok",
		mode: "pull",
		message: undefined,
		filesChecked: files.length,
		results: files.map((file) => ({
			file,
			serverId,
			freshness: "confirmed",
			documentVersion: 1,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					severity: 4,
					message: "a hint",
				},
			],
			documentText: "x = 1\n",
		})),
	}));
	try {
		writeFileSync(path, "x = 1\n");
		const result = await new EditFeedback(runtime, new BaselineStore()).after(
			{
				sessionId: "session",
				toolUseId: "patch",
				cwd: root,
				toolName: "apply_patch",
				toolInput: { command: `*** Begin Patch\n*** Add File: ${path}\n+x = 1\n*** End Patch` },
				toolResponse: "Exit code: 0",
			},
			new AbortController().signal,
		);
		expect(result.batch?.minimumSeverity).toBe("warning");
		expect(result.batch?.counts.total).toBe(0);
		expect(result.hookOutput).toEqual({});
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
