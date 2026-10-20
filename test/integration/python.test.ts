import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import type { DiagnosticBatch } from "../../src/core/diagnostics/batch.js";
import { findFirstExecutable } from "../../src/core/lsp/command.js";
import { describeWithTools } from "../support/tools.js";
import {
	activatedConda,
	activatedVenv,
	batchOf,
	callItemsOf,
	callsOf,
	createVenv,
	createWorkspace,
	hoverOf,
	installModule,
	installModuleWith,
	positionOf,
	requireTool,
	type Workspace,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

const PYTHON_MULTI_SOURCE = {
	schemaVersion: 1,
	languages: { python: { diagnosticServers: ["pyright", "ruff"] } },
};

const workspaces: Workspace[] = [];

function workspace(config?: unknown): Workspace {
	const created = createWorkspace(config);
	workspaces.push(created);
	return created;
}

afterEach(async () => {
	for (const created of workspaces.splice(0)) await created.close();
});

async function diagnose(w: Workspace, args: Record<string, unknown>): Promise<DiagnosticBatch> {
	return batchOf((await w.call("diagnostics", args)).data);
}

function codes(batch: DiagnosticBatch): string[] {
	return batch.diagnostics.map((diagnostic) => `${diagnostic.providerId}:${String(diagnostic.code)}`).sort();
}

describeWithTools("Python environments", ["python3", "pyright-langserver", "ruff", "uv"], () => {
	it("#given two venvs with different dependency types #when the same file is checked in each #then diagnostics follow the bound venv", async () => {
		// given
		const w = workspace();
		const venvA = createVenv(join(w.root, "envs", "a"));
		const venvB = createVenv(join(w.root, "envs", "b"));
		installModule(venvA, "depmod", "VALUE: int = 1\n");
		installModule(venvB, "depmod", 'VALUE: str = "x"\n');
		w.snapshot("env-venv-aaaa", activatedVenv(venvA));
		w.snapshot("env-venv-bbbb", activatedVenv(venvB));
		w.write("pyproject.toml", "[project]\nname = 'demo'\nversion = '0'\n");
		w.write("main.py", "from depmod import VALUE\n\ncount: int = VALUE\n");

		// when
		const inA = await diagnose(w, { filePath: "main.py", environmentId: "env-venv-aaaa" });
		const inB = await diagnose(w, { filePath: "main.py", environmentId: "env-venv-bbbb" });
		const status = await w.call("status", { filePath: "main.py", environmentId: "env-venv-bbbb" });

		// then
		expect(inA.complete).toBe(true);
		expect(inA.counts.error).toBe(0);
		expect(codes(inB)).toEqual(["pyright:reportAssignmentType"]);
		expect(inB.environment).toMatchObject({ environmentId: "env-venv-bbbb", source: "shell-snapshot" });
		const file = status.data["file"] as {
			toolchain: { status: string; facts: Record<string, string>; source: string };
		};
		expect(file.toolchain.status).toBe("resolved");
		expect(file.toolchain.facts["prefix"]).toBe(venvB);
		expect(file.toolchain.source).toContain("VIRTUAL_ENV");
		expect(w.runtime.manager.clientCount()).toBe(2);
	});

	it("#given a shell that deactivates its venv #when checking again #then the dependency disappears with the removed variables", async () => {
		// given
		const w = workspace();
		const venv = createVenv(join(w.root, "envs", "a"));
		installModule(venv, "depmod", "VALUE: int = 1\n");
		w.snapshot("env-shell-0001", activatedVenv(venv));
		w.write("main.py", "from depmod import VALUE\n\ncount: int = VALUE\n");
		const before = await diagnose(w, { filePath: "main.py", environmentId: "env-shell-0001" });

		// when
		const { VIRTUAL_ENV: _venv, ...deactivated } = process.env;
		w.snapshot("env-shell-0001", deactivated);
		const after = await diagnose(w, { filePath: "main.py", environmentId: "env-shell-0001", severity: "warning" });

		// then
		expect(before.counts.total).toBe(0);
		expect(after.environment.generation).toBe(2);
		expect(codes(after)).toContain("pyright:reportMissingImports");
	});

	it("#given VIRTUAL_ENV that disagrees with PATH #when checking #then the conflict is reported instead of using another Python", async () => {
		// given
		const w = workspace();
		const venvA = createVenv(join(w.root, "envs", "a"));
		const venvB = createVenv(join(w.root, "envs", "b"));
		w.snapshot("env-conflict1", { ...activatedVenv(venvB), VIRTUAL_ENV: venvA });
		w.write("main.py", "x = 1\n");

		// when
		const result = await w.call("diagnostics", { filePath: "main.py", environmentId: "env-conflict1" });
		const batch = batchOf(result.data);

		// then
		expect(result.partial).toBe(true);
		expect(batch.providers[0]).toMatchObject({ serverId: "pyright", status: "unavailable" });
		expect(batch.providers[0]?.message).toMatch(/VIRTUAL_ENV is .* but the PATH interpreter/);
		expect(w.runtime.manager.clientCount()).toBe(0);
	});

	it("#given Pyright and Ruff routed to Python #when one file has a type error and an unused import #then both sources report", async () => {
		// given
		const w = workspace(PYTHON_MULTI_SOURCE);
		const venv = createVenv(join(w.root, ".venv"));
		w.snapshot("env-multi-001", activatedVenv(venv));
		w.write("main.py", 'import os\n\nvalue: int = "text"\n');

		// when
		const batch = await diagnose(w, { filePath: "main.py", environmentId: "env-multi-001" });

		// then
		expect(batch.complete).toBe(true);
		expect(batch.providers.map((provider) => [provider.serverId, provider.status])).toEqual([
			["pyright", "ok"],
			["ruff", "ok"],
		]);
		expect(codes(batch)).toEqual(expect.arrayContaining(["pyright:reportAssignmentType", "ruff:F401"]));
		const clients = w.runtime.manager.activeClients();
		expect(clients).toHaveLength(2);
		expect(clients.every((client) => client.documents.size === 0 && client.pullCache.size === 0)).toBe(true);

		w.write("main.py", "value: int = 1\n");
		const fixed = await diagnose(w, { filePath: "main.py", environmentId: "env-multi-001" });
		expect(fixed.complete).toBe(true);
		expect(fixed.counts.total).toBe(0);
		for (let index = 0; index < 24; index += 1) w.write(`src/file_${index}.py`, "import os\n");
		const scanned = await diagnose(w, { filePath: "src", environmentId: "env-multi-001" });
		expect(scanned.complete).toBe(true);
		expect(scanned.coverage.checkedFiles).toBe(24);
		expect(scanned.diagnostics.filter((diagnostic) => diagnostic.code === "F401")).toHaveLength(24);
		expect(w.runtime.manager.activeClients()).toEqual(clients);
		expect(clients.every((client) => client.documents.size === 0 && client.pullCache.size === 0)).toBe(true);
	});

	it("#given a uv project environment at a custom path #when it is active and .venv also exists #then the active one is used and .venv is noted", async () => {
		// given
		const uv = requireTool("uv");
		const w = workspace();
		const custom = join(w.root, "envs", "uv-project");
		execFileSync(uv, ["venv", "--offline", "--quiet", "--python", requireTool("python3"), custom], { cwd: w.root });
		createVenv(join(w.root, ".venv"));
		w.snapshot("env-uv-00001", { ...activatedVenv(custom), UV_PROJECT_ENVIRONMENT: custom });
		w.write("pyproject.toml", "[project]\nname = 'demo'\nversion = '0'\n");
		w.write("main.py", "x = 1\n");

		// when
		const status = await w.call("status", { filePath: "main.py", environmentId: "env-uv-00001" });

		// then
		const toolchain = (status.data["file"] as { toolchain: { facts: Record<string, string>; notes: string[] } })
			.toolchain;
		expect(toolchain.facts["prefix"]).toBe(custom);
		expect(toolchain.notes.join("\n")).toContain(join(w.root, ".venv"));
	});
});

describeWithTools("Python navigation", ["python3", "pyright-langserver"], () => {
	it("#given a type from a venv dependency #when hovering a non-ASCII name #then Pyright resolves it in that venv", async () => {
		// given
		const w = workspace();
		const venv = createVenv(join(w.root, ".venv"));
		installModule(venv, "depmod", "class Widget:\n    pass\n");
		w.snapshot("env-hover-001", activatedVenv(venv));
		const source = "from depmod import Widget\n\n名前 = '😀'; 部品 = Widget()\n";
		w.write("main.py", source);
		const at = positionOf(source, "部品");

		// when
		const hover = hoverOf(
			(await w.call("hover", { filePath: "main.py", environmentId: "env-hover-001", ...at })).data,
		);

		// then
		expect(hover?.contents).toContain("部品: Widget");
		expect(hover?.range).toEqual({ start: at, end: { ...at, character: at.character + 2 } });
	});

	it("#given nested function calls #when walking the call hierarchy #then Pyright reports callers and callees", async () => {
		// given
		const w = workspace();
		const source =
			"def leaf() -> int:\n    return 1\n\n\ndef middle() -> int:\n    return leaf() + leaf()\n\n\ndef top() -> int:\n    return middle()\n";
		w.write("chain.py", source);

		// when
		const [middle] = callItemsOf(
			(await w.call("prepare_call_hierarchy", { filePath: "chain.py", ...positionOf(source, "middle") })).data,
		);
		if (middle === undefined) throw new Error("no call hierarchy item for middle");
		const incoming = callsOf((await w.call("incoming_calls", { item: middle.handle })).data);
		const outgoing = callsOf((await w.call("outgoing_calls", { item: middle.handle })).data);

		// then
		expect(incoming.map((call) => call.item.name)).toEqual(["top"]);
		expect(outgoing.map((call) => call.item.name)).toEqual(["leaf"]);
		expect(outgoing[0]?.fromRanges.map((range) => range.start)).toEqual([
			positionOf(source, "leaf", 1),
			positionOf(source, "leaf", 2),
		]);
	});

	it("#given Pyright, which has no implementation provider #when asking implementations #then capability_unsupported is reported", async () => {
		// given
		const w = workspace();
		w.write("main.py", "x = 1\n");

		// when
		const call = w.call("goto_implementation", { filePath: "main.py", line: 1, character: 0 });

		// then
		await expect(call).rejects.toMatchObject({ code: "capability_unsupported" });
	});
});

/** conda, mamba, or micromamba: whichever the machine (or CI) provides. */
function condaExecutable(): string | undefined {
	for (const variable of ["CONDA_EXE", "MAMBA_EXE"]) {
		const path = process.env[variable];
		if (path !== undefined && existsSync(path)) return path;
	}
	return findFirstExecutable(["conda", "mamba", "micromamba"], process.env);
}

const condaPython = (prefix: string): string =>
	process.platform === "win32" ? join(prefix, "python.exe") : join(prefix, "bin", "python");

/** Creates a real Conda environment with only Python; it downloads packages unless they are cached. */
async function createCondaEnv(conda: string, prefix: string): Promise<string> {
	await execFileAsync(
		conda,
		[
			"create",
			"--yes",
			"--quiet",
			"--prefix",
			prefix,
			"--override-channels",
			"--channel",
			"conda-forge",
			"python=3.12",
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	);
	return prefix;
}

describeWithTools(
	"Conda environments",
	["python3", "pyright-langserver"],
	() => {
		let root = "";
		let withModule = "";
		let withoutModule = "";

		beforeAll(async () => {
			const conda = condaExecutable();
			if (conda === undefined) throw new Error("conda disappeared after the suite was selected");
			root = realpathSync(mkdtempSync(join(tmpdir(), "lsp-it-conda-")));
			// One after the other: concurrent creates race on conda's shared package cache.
			withModule = await createCondaEnv(conda, join(root, "with-module"));
			withoutModule = await createCondaEnv(conda, join(root, "without-module"));
			// Only one environment gets the module, so import resolution shows which environment Pyright used.
			installModuleWith(condaPython(withModule), "lspprobe_conda", "VALUE: int = 1\n");
		});

		afterAll(() => {
			if (root !== "") rmSync(root, { recursive: true, force: true });
		});

		it("#given two Conda environments with different packages #when switching #then import resolution follows the active one", async () => {
			// given
			const w = workspace();
			w.snapshot("env-conda-with", activatedConda(withModule));
			w.snapshot("env-conda-without", activatedConda(withoutModule));
			w.write("main.py", "import lspprobe_conda\n");

			// when
			const inWith = await diagnose(w, {
				filePath: "main.py",
				environmentId: "env-conda-with",
				severity: "warning",
			});
			const inWithout = await diagnose(w, {
				filePath: "main.py",
				environmentId: "env-conda-without",
				severity: "warning",
			});

			// then
			expect(codes(inWith)).not.toContain("pyright:reportMissingImports");
			expect(codes(inWithout)).toContain("pyright:reportMissingImports");
		});

		it("#given a venv activated inside a Conda environment #when resolving #then the venv wins over CONDA_PREFIX", async () => {
			// given
			const w = workspace();
			const venv = createVenv(join(w.root, ".venv"));
			w.snapshot("env-nested-01", activatedVenv(venv, activatedConda(withoutModule)));
			w.write("main.py", "x = 1\n");

			// when
			const status = await w.call("status", { filePath: "main.py", environmentId: "env-nested-01" });

			// then
			const toolchain = (status.data["file"] as { toolchain: { status: string; facts: Record<string, string> } })
				.toolchain;
			expect(toolchain.status).toBe("resolved");
			expect(toolchain.facts["prefix"]).toBe(venv);
			expect(toolchain.facts["condaPrefix"]).toBe(withoutModule);
		});
	},
	[{ name: "conda, mamba, or micromamba", met: condaExecutable() !== undefined }],
);
