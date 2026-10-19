import { afterEach, describe, expect, it } from "vitest";

import { type StdioSession, startCli } from "../codex/helpers/stdio.js";
import { repoPath } from "../support/repo.js";

const sessions: StdioSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) {
		const cliPid = session.pid;
		const serverPid = session.fakeLog().find((entry) => entry.method === "initialize")?.pid;
		try {
			await session.client.close();
		} finally {
			// A failing regression test must not leave its deliberately stubborn processes behind.
			if (serverPid !== undefined) kill(-serverPid);
			if (cliPid !== null) kill(cliPid);
			await session.close();
		}
	}
});

function kill(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
	}
}

async function connect(behavior: Record<string, unknown>): Promise<StdioSession> {
	const session = await startCli({ SHUTDOWN_LSP_BEHAVIOR: JSON.stringify(behavior) }, [
		process.execPath,
		repoPath("test", "platform", "fixtures", "shutdown-lsp.mjs"),
	]);
	sessions.push(session);
	return session;
}

function definition(session: StdioSession) {
	const filePath = session.write("main.fake", "abc\n");
	return session.client.callTool({
		name: "goto_definition",
		arguments: { filePath, line: 1, character: 0 },
	});
}

async function start(behavior: Record<string, unknown> = {}): Promise<StdioSession> {
	const session = await connect(behavior);
	const result = await definition(session);
	expect(result.isError).not.toBe(true);
	return session;
}

function serverPid(session: StdioSession, method = "initialize"): number {
	const pid = session.fakeLog().find((entry) => entry.method === method)?.pid;
	if (pid === undefined) throw new Error(`no PID logged for ${method}`);
	return pid;
}

function cliPid(session: StdioSession): number {
	if (session.pid === null) throw new Error("CLI has no PID");
	return session.pid;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// POSIX signals; Windows delivers no SIGTERM to a console process, so the case does not apply there.
describe.skipIf(process.platform === "win32")("CLI process shutdown (POSIX signals)", () => {
	it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
		"#given a running language server #when the CLI receives %s #then the process group exits",
		async (signal) => {
			// given
			const session = await start();
			const owner = cliPid(session);
			const server = serverPid(session);

			// when
			process.kill(owner, signal);
			await waitUntil(() => !alive(owner), 2_000);

			// then
			expect(session.fakeLog().map((entry) => entry.method)).toContain("shutdown");
			expect(alive(-server)).toBe(false);
		},
	);

	it("#given a slow uncooperative LSP #when MCP stdin closes #then the entire group stops before the host kills the CLI", async () => {
		const session = await start({ shutdownDelayMs: 6_000, ignoreTerm: true });
		const server = serverPid(session);
		await session.client.close();
		expect(alive(-server)).toBe(false);
	});

	it("#given a host with a two-second shutdown grace #when TERM is repeated during cleanup #then cleanup finishes before host escalation", async () => {
		const session = await start({ shutdownDelayMs: 6_000, ignoreTerm: true });
		const owner = cliPid(session);
		const server = serverPid(session);
		let escalated = false;
		const deadline = setTimeout(() => {
			if (alive(owner)) {
				escalated = true;
				kill(owner);
			}
		}, 2_000);
		try {
			process.kill(owner, "SIGTERM");
			await waitUntil(() => session.fakeLog().some((entry) => entry.method === "shutdown"), 1_000);
			process.kill(owner, "SIGTERM");
			await waitUntil(() => !alive(owner), 2_500);
			expect(escalated).toBe(false);
			expect(alive(-server)).toBe(false);
		} finally {
			clearTimeout(deadline);
		}
	});

	it.each([false, true])(
		"#given a dead LSP leader and a worker (inherited pipes: %s) #when MCP closes #then its worker is also stopped",
		async (workerInheritPipes) => {
			const session = await start({ worker: true, exitAfterDefinition: true, workerInheritPipes });
			const server = serverPid(session);
			serverPid(session, "worker");
			await waitUntil(() => !alive(server), 1_000);
			await session.client.close();
			expect(alive(-server)).toBe(false);
		},
	);

	it("#given a worker ignoring TERM #when its LSP leader exits during shutdown #then the worker is killed too", async () => {
		const session = await start({ worker: true, workerIgnoreTerm: true });
		const server = serverPid(session);
		await session.client.close();
		expect(alive(-server)).toBe(false);
	});

	it("#given a worker holding the pipes #when its LSP leader exits #then its group is reaped without waiting for MCP shutdown", async () => {
		const session = await start({
			worker: true,
			workerIgnoreTerm: true,
			workerInheritPipes: true,
			exitAfterDefinition: true,
		});
		const server = serverPid(session);
		await waitUntil(() => !alive(-server), 2_000);
		expect((await session.client.listTools()).tools.length).toBeGreaterThan(0);
	});

	it("#given an LSP still initializing #when MCP closes #then startup cannot leave a server behind", async () => {
		const session = await connect({ initializeDelayMs: 6_000, ignoreTerm: true });
		const pending = definition(session).then(
			() => "answered",
			() => "disconnected",
		);
		await waitUntil(() => session.fakeLog().some((entry) => entry.method === "initialize"), 2_000);
		const server = serverPid(session);
		await session.client.close();
		await pending;
		expect(alive(-server)).toBe(false);
	});
});
