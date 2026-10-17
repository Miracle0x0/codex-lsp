import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { isolatedContext } from "../support/context.js";
import { CLI_PATH } from "../support/repo.js";

it("#given two captured environments #when one is explicitly removed #then listing and disk agree and the other survives", () => {
	const context = isolatedContext("lsp-env-management");
	const run = (...args: string[]) =>
		spawnSync(process.execPath, [CLI_PATH, "env", ...args], { env: context.env, encoding: "utf8" });
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
		expect(existsSync(join(context.stateDir, "environments", first))).toBe(false);
		expect(existsSync(join(context.stateDir, "environments", second))).toBe(true);
		expect(run("remove", "../../invalid").status).not.toBe(0);
		expect(run("remove", first).status).not.toBe(0);
	} finally {
		context.cleanup();
	}
});
