import { describe, expect, it } from "vitest";

import { LspProcessExitedError } from "../../src/core/lsp/errors.js";
import { LspManager } from "../../src/core/lsp/manager.js";
import { FakeLspClient, type FakeLspClientOptions, makeTarget } from "./helpers/fake-lsp-client.js";

function setupManager(optionsFor: () => FakeLspClientOptions = () => ({})) {
	const clients: FakeLspClient[] = [];
	const manager = new LspManager({
		idleTimeoutMs: 5_000,
		initTimeoutMs: 1_000,
		reaperIntervalMs: 100,
		clientFactory: (target) => {
			const client = new FakeLspClient(target, optionsFor());
			clients.push(client);
			return client;
		},
	});
	return { manager, clients };
}

type ProcessSignalListener = (...args: never[]) => unknown;

function findAddedListener(
	signal: NodeJS.Signals,
	before: readonly ProcessSignalListener[],
): ProcessSignalListener | undefined {
	return process.listeners(signal).find((listener) => !before.includes(listener));
}

describe("LspManager", () => {
	it("#given a failed start #when acquiring again #then the failed client is stopped and a fresh one is built", async () => {
		// given
		let calls = 0;
		const { manager, clients } = setupManager(() => ({ failStart: calls++ === 0 }));
		const target = makeTarget("typescript");

		// when
		await expect(manager.acquire(target)).rejects.toThrow("fake start failed");

		// then
		expect(manager.snapshot()).toEqual([]);
		expect(clients[0]?.stopCallCount).toBeGreaterThan(0);
		const fresh = await manager.acquire(target);
		expect(clients).toHaveLength(2);
		expect(fresh).toBe(clients[1]);
		await manager.stopAll();
	});

	it("#given concurrent acquires for one target #when the client is still starting #then one client is shared", async () => {
		// given
		const { manager, clients } = setupManager(() => ({ startDelayMs: 20 }));
		const target = makeTarget("pyright");

		// when
		const [first, second] = await Promise.all([manager.acquire(target), manager.acquire(target)]);

		// then
		expect(first).toBe(second);
		expect(clients).toHaveLength(1);
		expect(manager.snapshot()[0]?.refCount).toBe(2);
		await manager.stopAll();
	});

	it("#given a new environment fingerprint in the same slot #when acquiring #then the old idle client is stopped", async () => {
		// given
		const { manager, clients } = setupManager();
		const before = makeTarget("pyright", { key: "slot#env-a" });
		const after = makeTarget("pyright", { key: "slot#env-b" });
		manager.release(await manager.acquire(before));

		// when
		await manager.acquire(after);

		// then
		expect(clients[0]?.stopCallCount).toBe(1);
		expect(manager.snapshot().map((client) => client.key)).toEqual(["slot#env-b"]);
		await manager.stopAll();
	});

	it("#given a busy client in a replaced slot #when it is released #then it stops instead of idling", async () => {
		// given
		const { manager, clients } = setupManager();
		const busy = await manager.acquire(makeTarget("pyright", { key: "slot#env-a" }));
		await manager.acquire(makeTarget("pyright", { key: "slot#env-b" }));
		expect(manager.snapshot().find((client) => client.key === "slot#env-a")?.state).toBe("retired");

		// when
		manager.release(busy);

		// then
		expect(clients[0]?.stopCallCount).toBe(1);
		expect(manager.snapshot().map((client) => client.key)).toEqual(["slot#env-b"]);
		await manager.stopAll();
	});

	it("#given a read-only operation whose server dies #when using withClient #then it retries once on a fresh client", async () => {
		// given
		const { manager, clients } = setupManager();
		const target = makeTarget("gopls");
		let attempts = 0;

		// when
		const result = await manager.withClient(
			target,
			async () => {
				attempts += 1;
				if (attempts === 1) {
					clients[0]?.kill();
					throw new LspProcessExitedError("gopls", "/root", 1);
				}
				return "ok";
			},
			{ readOnly: true },
		);

		// then
		expect(result).toBe("ok");
		expect(clients).toHaveLength(2);
		await manager.stopAll();
	});

	it("#given a write operation whose server dies #when using withClient #then it does not retry", async () => {
		// given
		const { manager, clients } = setupManager();

		// when
		const call = manager.withClient(
			makeTarget("typescript"),
			async () => {
				throw new LspProcessExitedError("typescript", "/root", 1);
			},
			{ readOnly: false },
		);

		// then
		await expect(call).rejects.toBeInstanceOf(LspProcessExitedError);
		expect(clients).toHaveLength(1);
		await manager.stopAll();
	});

	it("#given an active client #when signal cleanup runs #then the client stops and handlers unregister", async () => {
		// given
		const beforeSigterm = process.listeners("SIGTERM");
		const { manager, clients } = setupManager();
		try {
			manager.release(await manager.acquire(makeTarget("typescript")));

			// when
			const listener = findAddedListener("SIGTERM", beforeSigterm);
			expect(listener).toBeDefined();
			listener?.();
			await new Promise((resolve) => setTimeout(resolve, 0));

			// then
			expect(clients[0]?.stopCallCount).toBe(1);
			expect(manager.clientCount()).toBe(0);
			expect(process.listeners("SIGTERM")).toEqual(beforeSigterm);
		} finally {
			await manager.stopAll();
		}
	});
});
