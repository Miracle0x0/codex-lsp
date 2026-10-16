import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { REPO_ROOT } from "./helpers/stdio.js";

it("#given two captured environments #when one is explicitly removed #then listing and disk agree and the other survives", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "lsp-env-management-"));
	const cli = join(REPO_ROOT, "dist", "cli.js");
	const { CODEX_LSP_CONTEXT_ID: _id, CODEX_LSP_ENV_MANIFEST: _manifest, ...base } = process.env;
	const run = (...args: string[]) =>
		spawnSync(process.execPath, [cli, "env", ...args], {
			env: { ...base, CODEX_LSP_STATE_DIR: stateDir },
			encoding: "utf8",
		});
	try {
		const first = run("capture").stdout.trim();
		const second = run("capture").stdout.trim();
		const listed = run("list");
		expect(listed.status).toBe(0);
		expect(JSON.parse(listed.stdout)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ environmentId: first }),
				expect.objectContaining({ environmentId: second }),
			]),
		);
		expect(run("remove", first).status).toBe(0);
		expect(existsSync(join(stateDir, "environments", first))).toBe(false);
		expect(existsSync(join(stateDir, "environments", second))).toBe(true);
		expect(run("remove", "../../invalid").status).not.toBe(0);
		expect(run("remove", first).status).not.toBe(0);
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});
