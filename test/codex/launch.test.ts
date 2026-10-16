import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { REPO_ROOT, requireBuiltCli } from "./helpers/stdio.js";

const CLI = join(REPO_ROOT, "dist", "cli.js");
const roots: string[] = [];

beforeAll(requireBuiltCli);

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("codex-lsp launch", () => {
	it("#given an activated venv #when launching #then Codex starts without the daemon and with the captured environment bound", () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "codex-lsp-launch-"));
		roots.push(root);
		const record = join(root, "codex-invocation.txt");
		writeFileSync(
			join(root, "codex"),
			`#!/bin/sh\n{ printf 'args=%s\\n' "$*"; printf 'id=%s\\n' "$CODEX_LSP_CONTEXT_ID"; printf 'manifest=%s\\n' "$CODEX_LSP_ENV_MANIFEST"; } > ${JSON.stringify(record)}\nexit 7\n`,
		);
		chmodSync(join(root, "codex"), 0o755);
		const stateDir = join(root, "state");
		const env = {
			...process.env,
			PATH: [root, process.env["PATH"] ?? ""].join(delimiter),
			CODEX_LSP_STATE_DIR: stateDir,
			VIRTUAL_ENV: "/envs/launch",
		};

		// when
		const result = spawnSync(process.execPath, [CLI, "launch", "--", "exec", "hello"], { env, encoding: "utf8" });

		// then
		expect(result.status).toBe(7);
		const fields = Object.fromEntries(
			readFileSync(record, "utf8")
				.trim()
				.split("\n")
				.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
		);
		expect(fields["args"]).toBe("--no-daemon exec hello");
		expect(fields["manifest"]).toBe(join(stateDir, "environments", fields["id"] ?? "", "manifest.json"));
		const manifest = JSON.parse(readFileSync(fields["manifest"] ?? "", "utf8"));
		const snapshot = JSON.parse(
			readFileSync(join(stateDir, "environments", fields["id"] ?? "", manifest.snapshot), "utf8"),
		);
		expect(snapshot).toMatchObject({ kind: "launch", variables: { VIRTUAL_ENV: "/envs/launch" } });
	});
});
