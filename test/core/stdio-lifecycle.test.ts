import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { LspManager } from "../../src/core/lsp/manager.js";
import { serveLspStdio } from "../../src/core/mcp/server.js";
import { createLspRuntime } from "../../src/core/runtime/runtime.js";
import { isolatedContext } from "../support/context.js";
import { FakeLspClient, type FakeLspClientOptions, makeTarget } from "./helpers/fake-lsp-client.js";

async function start(options: FakeLspClientOptions = {}) {
	const context = isolatedContext("stdio-lifecycle");
	const client = new FakeLspClient(makeTarget("fake"), options);
	const manager = new LspManager({ clientFactory: () => client });
	manager.release(await manager.acquire(client.target));
	const runtime = createLspRuntime({ config: context.config, manager });
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const handle = serveLspStdio(runtime, { stdin, stdout });
	return { context, client, manager, stdin, stdout, handle };
}

describe("stdio runtime lifetime", () => {
	it.each(["EOF", "stdin-close", "stdout-error"] as const)(
		"#given an active runtime #when the transport receives %s #then its clients stop",
		async (event) => {
			const { context, client, manager, stdin, stdout, handle } = await start();
			try {
				if (event === "EOF") stdin.end();
				else if (event === "stdin-close") stdin.destroy();
				else stdout.destroy(new Error("write failed"));
				await handle.closed;
				expect(client.isAlive()).toBe(false);
				expect(client.stopCallCount).toBe(1);
				await expect(manager.acquire(client.target)).rejects.toThrow("disposed");
			} finally {
				await handle.close();
				context.cleanup();
			}
		},
	);

	it("#given a client still stopping #when close is repeated #then every caller waits for the same cleanup", async () => {
		let finish!: () => void;
		const stopGate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { context, client, handle } = await start({ stopGate });
		let finished = false;
		const close = handle.close();
		void close.then(() => {
			finished = true;
		});
		try {
			expect(handle.close()).toBe(close);
			await setImmediate();
			expect(finished).toBe(false);
			expect(client.stopCallCount).toBe(1);
		} finally {
			finish();
			await close;
			context.cleanup();
		}
	});

	it("#given a client that cannot stop #when the transport closes #then closed rejects with the failure", async () => {
		const { context, stdin, handle } = await start({ failStop: true });
		const stopped = expect(handle.closed).rejects.toThrow("fake stop failed");
		try {
			stdin.end();
			await stopped;
		} finally {
			context.cleanup();
		}
	});
});
