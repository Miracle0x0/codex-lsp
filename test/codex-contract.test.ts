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
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./helpers/stdio.js";

/**
 * Real Codex host contract: installs the staged plugin from a local marketplace into a temporary
 * CODEX_HOME and checks that the PostToolUse mcp_tool hook injects diagnostics after apply_patch and
 * after a shell command. Needs network, Codex auth, and pyright; run with CODEX_LSP_CONTRACT=1 after
 * `pnpm run test:package`.
 */
const ENABLED = process.env["CODEX_LSP_CONTRACT"] === "1";
const ARTIFACT = join(REPO_ROOT, "artifacts", "codex-lsp-plugin");
const AUTH = process.env["CODEX_LSP_CONTRACT_AUTH"] ?? join(homedir(), ".codex", "auth.json");
/** Keeps the temporary Codex home and workspace for inspection. */
const KEEP = process.env["CODEX_LSP_CONTRACT_KEEP"] === "1";

function sessionText(home: string): string {
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
}

describe.runIf(ENABLED)("Codex host contract", () => {
	it("#given the installed plugin #when Codex edits with apply_patch and a shell command #then diagnostics reach the model", () => {
		// given
		if (!existsSync(join(ARTIFACT, "dist", "cli.js"))) throw new Error("run pnpm run test:package first");
		const root = mkdtempSync(join(tmpdir(), "codex-lsp-contract-"));
		try {
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
					'[plugins."codex-lsp@contract"]',
					"enabled = true",
					`[projects.${JSON.stringify(workspace)}]`,
					'trust_level = "trusted"',
				].join("\n"),
			);
			writeFileSync(join(workspace, "main.py"), "count: int = 1\n");
			const env = { ...process.env, CODEX_HOME: home };
			execFileSync("codex", ["plugin", "add", "codex-lsp@contract"], { env, input: "", stdio: "pipe" });
			const prompt = [
				"Do exactly these two steps, one tool call each, and nothing else:",
				`1) ${join(workspace, "main.py")} contains exactly one line, "count: int = 1". Use apply_patch with one`,
				'   "*** Update File:" section that replaces that line with: count: int = "text"',
				"2) Run this shell command: printf 'name: str = 1\\n' > made.py",
				"Then reply DONE.",
			].join("\n");

			// when
			execFileSync("codex", ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", prompt], {
				cwd: workspace,
				env,
				input: "",
				timeout: 280_000,
				stdio: ["pipe", "pipe", "pipe"],
			});

			// then
			const transcript = sessionText(home);
			expect(transcript).toContain("LSP diagnostics after apply_patch");
			expect(transcript).toContain("reportAssignmentType");
			expect(transcript).toContain("LSP diagnostics after Bash");
			expect(transcript).toContain("made.py: new file with 1 problem(s)");
		} finally {
			if (KEEP) process.stderr.write(`codex contract files kept in ${root}\n`);
			else rmSync(root, { recursive: true, force: true });
		}
	}, 300_000);
});
