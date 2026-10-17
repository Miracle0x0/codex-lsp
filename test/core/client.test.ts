import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LspClient } from "../../src/core/lsp/client.js";
import { LspRequestCancelledError } from "../../src/core/lsp/errors.js";
import { makeTarget } from "./helpers/fake-lsp-client.js";
import { FAKE_SERVER_PATH } from "./helpers/mcp-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A real LspClient on the fake server process, in a private project directory. */
async function startClient(): Promise<{ client: LspClient; root: string }> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lsp-client-")));
	const client = new LspClient({
		...makeTarget("fake"),
		executable: process.execPath,
		args: [FAKE_SERVER_PATH],
		projectRoot: root,
		workspaceRoot: root,
		env: { PATH: process.env["PATH"] ?? "" },
	});
	cleanups.push(async () => {
		await client.stop();
		rmSync(root, { recursive: true, force: true });
	});
	await client.start();
	return { client, root };
}

const timers = (): number => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

describe("LspClient waits", () => {
	it("#given a signal aborted before the wait #when waiting for a publish #then it is cancelled at once, not at the timeout", async () => {
		// given
		const { client, root } = await startClient();
		const controller = new AbortController();
		controller.abort();
		const before = timers();

		// when
		const wait = client.waitForPublish(
			pathToFileURL(join(root, "a.fake")).href,
			() => true,
			60_000,
			controller.signal,
		);

		// then
		await expect(wait).rejects.toBeInstanceOf(LspRequestCancelledError);
		expect(timers()).toBeLessThanOrEqual(before);
	});

	it("#given a wait that times out #when it settles #then its listeners are gone", async () => {
		// given
		const { client, root } = await startClient();
		const before = timers();

		// when
		const result = await client.waitForPublish(pathToFileURL(join(root, "never.fake")).href, () => true, 20);

		// then
		expect(result).toBeNull();
		expect(timers()).toBeLessThanOrEqual(before);
	});

	it("#given a running server #when the client stops #then no shutdown timer is left running", async () => {
		// given
		const { client } = await startClient();
		const before = timers();

		// when
		await client.stop();

		// then
		expect(client.isAlive()).toBe(false);
		expect(timers()).toBeLessThanOrEqual(before);
	});
});
