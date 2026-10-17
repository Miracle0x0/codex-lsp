import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type StdioSession, startCli } from "../codex/helpers/stdio.js";

const sessions: StdioSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

async function start(): Promise<StdioSession> {
	const session = await startCli();
	sessions.push(session);
	return session;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
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
	it("#given a running language server #when the CLI receives SIGTERM #then it shuts the server down before exiting", async () => {
		// given
		const session = await start();
		session.write("main.fake", "abc\n");
		await session.client.callTool({
			name: "goto_definition",
			arguments: { filePath: join(session.workspace, "main.fake"), line: 1, character: 0 },
		});
		const serverPid = session.fakeLog().find((entry) => entry.method === "initialize")?.pid;
		expect(serverPid).toBeDefined();
		const cliPid = session.pid;
		expect(cliPid).not.toBeNull();

		// when
		process.kill(cliPid ?? 0, "SIGTERM");
		await waitUntil(() => !alive(cliPid ?? 0), 3_000);

		// then
		expect(session.fakeLog().map((entry) => entry.method)).toContain("shutdown");
		expect(alive(serverPid ?? 0)).toBe(false);
	});
});
