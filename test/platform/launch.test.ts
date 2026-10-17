import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { isolatedContext } from "../support/context.js";
import { CLI_PATH } from "../support/repo.js";

// The stand-in Codex is a /bin/sh script, so this case applies to POSIX systems.
describe.skipIf(process.platform === "win32")("codex-lsp launch (POSIX)", () => {
	it("#given an activated venv #when launching #then Codex starts without the daemon and with the captured environment bound", () => {
		// given
		const context = isolatedContext("codex-lsp-launch");
		const bin = join(context.root, "bin");
		const record = join(context.root, "codex-invocation.txt");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "codex"),
			`#!/bin/sh\n{ printf 'args=%s\\n' "$*"; printf 'id=%s\\n' "$CODEX_LSP_CONTEXT_ID"; printf 'manifest=%s\\n' "$CODEX_LSP_ENV_MANIFEST"; } > ${JSON.stringify(record)}\nexit 7\n`,
		);
		chmodSync(join(bin, "codex"), 0o755);
		const env = {
			...context.env,
			PATH: [bin, context.env["PATH"] ?? ""].join(delimiter),
			VIRTUAL_ENV: "/envs/launch",
		};

		try {
			// when
			const result = spawnSync(process.execPath, [CLI_PATH, "launch", "--", "exec", "hello"], {
				env,
				encoding: "utf8",
			});

			// then
			expect(result.status).toBe(7);
			const fields = Object.fromEntries(
				readFileSync(record, "utf8")
					.trim()
					.split("\n")
					.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
			);
			expect(fields["args"]).toBe("--no-daemon exec hello");
			const environment = join(context.stateDir, "environments", fields["id"] ?? "");
			expect(fields["manifest"]).toBe(join(environment, "manifest.json"));
			const manifest = JSON.parse(readFileSync(fields["manifest"] ?? "", "utf8"));
			const snapshot = JSON.parse(readFileSync(join(environment, manifest.snapshot), "utf8"));
			expect(snapshot).toMatchObject({ kind: "launch", variables: { VIRTUAL_ENV: "/envs/launch" } });
		} finally {
			context.cleanup();
		}
	});
});
