import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { builtHash, sourceHash } from "../../scripts/source-hash.mjs";
import { toolchainEnv } from "../support/context.js";
import { REPO_ROOT } from "../support/repo.js";
import { describeWithTools } from "../support/tools.js";

/**
 * Real Codex host contract: installs the staged plugin from a local marketplace into a temporary CODEX_HOME
 * and drives Codex itself. Run `pnpm run test:package` first; it needs network, Codex auth, python3, and Pyright.
 */
const ARTIFACT = join(REPO_ROOT, "artifacts", "codex-lsp-plugin");
const AUTH = process.env["CODEX_LSP_CONTRACT_AUTH"] ?? join(homedir(), ".codex", "auth.json");
/** Keeps the temporary Codex home and workspace for inspection. */
const KEEP = process.env["CODEX_LSP_CONTRACT_KEEP"] === "1";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		if (KEEP) process.stderr.write(`codex contract files kept in ${root}\n`);
		else rmSync(root, { recursive: true, force: true });
	}
});

interface Host {
	readonly root: string;
	readonly home: string;
	readonly workspace: string;
	readonly env: NodeJS.ProcessEnv;
	/** Session records Codex wrote, which include hook additionalContext. */
	transcript(): string;
}

function installPlugin(): Host {
	const root = mkdtempSync(join(tmpdir(), "codex-lsp-contract-"));
	roots.push(root);
	const market = join(root, "market");
	mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
	cpSync(ARTIFACT, join(market, "plugins", "codex-lsp"), { recursive: true });
	writeFileSync(
		join(market, ".agents", "plugins", "marketplace.json"),
		JSON.stringify({
			name: "contract",
			plugins: [
				{
					name: "codex-lsp",
					source: { source: "local", path: "./plugins/codex-lsp" },
					policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				},
			],
		}),
	);
	const home = join(root, "home");
	const workspace = join(root, "ws");
	mkdirSync(home);
	mkdirSync(workspace);
	symlinkSync(AUTH, join(home, "auth.json"));
	writeFileSync(
		join(home, "config.toml"),
		[
			'sandbox_mode = "workspace-write"',
			'approval_policy = "never"',
			"suppress_unstable_features_warning = true",
			"[features]",
			"mcp_2026_07_28 = true",
			"[marketplaces.contract]",
			'source_type = "local"',
			`source = ${JSON.stringify(market)}`,
			`[projects.${JSON.stringify(workspace)}]`,
			'trust_level = "trusted"',
		].join("\n"),
	);
	const env = { ...toolchainEnv(), CODEX_HOME: home, CODEX_LSP_STATE_DIR: join(root, "state") };
	execFileSync("codex", ["plugin", "add", "codex-lsp@contract"], { env, input: "", stdio: "pipe" });
	return {
		root,
		home,
		workspace,
		env,
		transcript() {
			const files: string[] = [];
			const visit = (directory: string): void => {
				for (const entry of readdirSync(directory, { withFileTypes: true })) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) visit(path);
					else if (entry.name.endsWith(".jsonl")) files.push(path);
				}
			};
			visit(join(home, "sessions"));
			return files.map((file) => readFileSync(file, "utf8")).join("\n");
		},
	};
}

const EXEC_FLAGS = ["--skip-git-repo-check", "--dangerously-bypass-hook-trust"];
const RUN = { input: "", timeout: 280_000, stdio: "pipe" } as const;

describeWithTools(
	"Codex host contract",
	["codex", "python3", "pyright-langserver"],
	() => {
		it("#given the installed plugin #when Codex edits with apply_patch and a shell command #then diagnostics reach the model", () => {
			// given
			const host = installPlugin();
			writeFileSync(join(host.workspace, "main.py"), "count: int = 1\n");
			const prompt = [
				"Do exactly these two steps, one tool call each, and nothing else:",
				`1) ${join(host.workspace, "main.py")} contains exactly one line, "count: int = 1". Use apply_patch with one`,
				'   "*** Update File:" section that replaces that line with: count: int = "text"',
				"2) Run this shell command: printf 'name: str = 1\\n' > made.py",
				"Then reply DONE.",
			].join("\n");

			// when
			execFileSync("codex", ["exec", ...EXEC_FLAGS, prompt], { ...RUN, cwd: host.workspace, env: host.env });

			// then
			const transcript = host.transcript();
			expect(transcript).toContain("LSP diagnostics after apply_patch");
			expect(transcript).toContain("reportAssignmentType");
			expect(transcript).toContain("LSP diagnostics after Bash");
			expect(transcript).toContain("made.py: new file with 1 problem(s)");
		}, 300_000);

		it("#given Codex started by codex-lsp launch from a shell with a venv active #when a patch uses a venv package #then Pyright resolves it in that venv", () => {
			// given
			const host = installPlugin();
			const venv = join(host.root, "venv");
			execFileSync("python3", ["-m", "venv", "--without-pip", venv]);
			const python = join(venv, "bin", "python");
			const purelib = execFileSync(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
				encoding: "utf8",
			}).trim();
			mkdirSync(join(purelib, "depmod"));
			writeFileSync(join(purelib, "depmod", "__init__.py"), 'VALUE: str = "x"\n');
			writeFileSync(join(host.workspace, "main.py"), "from depmod import VALUE\n\ncount = VALUE\n");
			const prompt = [
				`${join(host.workspace, "main.py")} has three lines; the last is "count = VALUE".`,
				'Use apply_patch once, with one "*** Update File:" section, to replace that line with: count: int = VALUE',
				"Do nothing else, then reply DONE.",
			].join("\n");
			const activated = {
				...host.env,
				VIRTUAL_ENV: venv,
				PATH: [join(venv, "bin"), host.env["PATH"] ?? ""].join(delimiter),
			};

			// when
			execFileSync(
				process.execPath,
				[join(ARTIFACT, "dist", "cli.js"), "launch", "--", "exec", ...EXEC_FLAGS, prompt],
				{
					...RUN,
					cwd: host.workspace,
					env: activated,
				},
			);

			// then
			const transcript = host.transcript();
			expect(transcript).toContain("LSP diagnostics after apply_patch");
			expect(transcript).toContain("reportAssignmentType");
			expect(transcript).not.toContain("reportMissingImports");
		}, 300_000);
	},
	[
		{
			name: "plugin staged from the current sources (pnpm run test:package)",
			met: builtHash(ARTIFACT) !== undefined && builtHash(ARTIFACT) === sourceHash(REPO_ROOT),
		},
		{ name: `Codex authentication at ${AUTH}`, met: existsSync(AUTH) },
		// The launch case builds a POSIX venv (venv/bin/python).
		{ name: "a POSIX platform", met: process.platform !== "win32" },
	],
);
