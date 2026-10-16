import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { requireBuiltCli, type StdioSession, startCli, textOf } from "./helpers/stdio.js";

const sessions: StdioSession[] = [];

beforeAll(requireBuiltCli);

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

async function start(): Promise<StdioSession> {
	const session = await startCli();
	sessions.push(session);
	return session;
}

const PATCH_OK = "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\n";
let callCounter = 0;

interface HookOutput {
	readonly hookSpecificOutput?: { readonly hookEventName: string; readonly additionalContext: string };
}

/** Plays one Codex tool call through both hooks, running `edit` between them like the real tool would. */
async function toolCall(
	session: StdioSession,
	toolName: "apply_patch" | "Bash",
	command: string,
	edit: () => void,
	toolResponse: string = toolName === "apply_patch" ? PATCH_OK : "",
): Promise<HookOutput> {
	callCounter += 1;
	const event = {
		sessionId: "session-1",
		toolUseId: `exec-${callCounter}`,
		cwd: session.workspace,
		toolName,
		toolInput: { command },
	};
	const pre = await session.client.callTool({ name: "pre_edit_snapshot", arguments: event });
	expect(textOf(pre)).toBe("{}");
	edit();
	const post = await session.client.callTool({
		name: "post_edit_diagnostics",
		arguments: { ...event, turnId: "turn-1", toolResponse },
	});
	expect(post.isError).toBeUndefined();
	return JSON.parse(textOf(post)) as HookOutput;
}

const contextOf = (output: HookOutput): string => output.hookSpecificOutput?.additionalContext ?? "";
const update = (path: string) => `*** Begin Patch\n*** Update File: ${path}\n@@\n*** End Patch`;

describe("post_edit_diagnostics hook", () => {
	it("#given a file with an existing problem #when a patch adds another #then only the new one is reported as new", async () => {
		// given
		const session = await start();
		const path = session.write("main.fake", "abc\nERROR old\n");

		// when
		const output = await toolCall(session, "apply_patch", update(path), () =>
			writeFileSync(path, "abc\nERROR old\nERROR new\n"),
		);

		// then
		expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
		const context = contextOf(output);
		expect(context).toContain(`${path}: 1 new problem(s)`);
		expect(context).toContain(`${path}:3:0 error [fake error-code] ERROR marker on line 3`);
		expect(context).not.toContain("line 2");
	});

	it("#given consecutive edits #when each is checked #then one language server process serves them all", async () => {
		// given
		const session = await start();
		const path = session.write("main.fake", "abc\n");

		// when
		await toolCall(session, "apply_patch", update(path), () => writeFileSync(path, "abc\nERROR one\n"));
		const second = await toolCall(session, "apply_patch", update(path), () => writeFileSync(path, "abc\n"));

		// then
		expect(contextOf(second)).toContain(`${path}: 1 problem(s) resolved`);
		const servers = new Set(
			session
				.fakeLog()
				.filter((entry) => entry.method === "initialize")
				.map((entry) => entry.pid),
		);
		expect(servers.size).toBe(1);
	});

	it("#given a clean edit #when nothing new is found #then the hook returns empty output", async () => {
		// given
		const session = await start();
		const path = session.write("main.fake", "abc\n");

		// when
		const output = await toolCall(session, "apply_patch", update(path), () => writeFileSync(path, "abcd\n"));

		// then
		expect(output).toEqual({});
	});

	it("#given a failed patch #when the hook runs #then nothing is checked", async () => {
		// given
		const session = await start();
		const path = session.write("main.fake", "ERROR\n");

		// when
		const output = await toolCall(
			session,
			"apply_patch",
			update(path),
			() => undefined,
			"Exit code: 1\nOutput:\nerror",
		);

		// then
		expect(output).toEqual({});
	});

	it("#given a moved file #when the destination gains a problem #then the baseline follows the move", async () => {
		// given
		const session = await start();
		const from = session.write("old.fake", "ERROR kept\n");
		const to = join(session.workspace, "new.fake");
		const patch = `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n*** End Patch`;

		// when
		const output = await toolCall(session, "apply_patch", patch, () => {
			renameSync(from, to);
			writeFileSync(to, "ERROR kept\nERROR added\n");
		});

		// then
		const context = contextOf(output);
		expect(context).toContain(`${to}: 1 new problem(s)`);
		expect(context).toContain("ERROR marker on line 2");
		expect(context).not.toContain(from);
	});

	it("#given a shell command that creates a file #when the hook runs #then the journal finds it and reports its problems", async () => {
		// given
		const session = await start();
		session.write("existing.fake", "abc\n");

		// when
		const output = await toolCall(session, "Bash", "printf 'ERROR\\n' > made.fake", () =>
			writeFileSync(join(session.workspace, "made.fake"), "ERROR\n"),
		);

		// then
		expect(contextOf(output)).toContain(`${join(session.workspace, "made.fake")}: new file with 1 problem(s)`);
	});

	it("#given a shell command that edits a file never checked before #when the hook runs #then existing problems are not blamed on it", async () => {
		// given
		const session = await start();
		const path = session.write("legacy.fake", "ERROR old\n");

		// when
		const output = await toolCall(session, "Bash", "sed -i ...", () => writeFileSync(path, "ERROR old\nok\n"));

		// then
		expect(contextOf(output)).toContain(
			`${path}: first check in this session; 1 existing problem(s), not attributed to this edit`,
		);
	});

	it("#given files without a configured language #when edited #then the hook stays silent", async () => {
		// given
		const session = await start();
		const path = session.write("notes.txt", "x\n");

		// when
		const output = await toolCall(session, "apply_patch", update(path), () => writeFileSync(path, "y\n"));

		// then
		expect(output).toEqual({});
		expect(session.fakeLog()).toEqual([]);
	});
});

describe("post_edit_diagnostics failures", () => {
	it("#given the language server is not installed #when a file is edited #then the hook reports it instead of staying silent", async () => {
		// given
		const session = await start();
		session.write(
			"lsp-client.json",
			JSON.stringify({
				schemaVersion: 1,
				servers: { ghost: { command: ["codex-lsp-no-such-server"], installHint: "npm install -g ghost-ls" } },
				languages: { ghost: { extensions: [".ghost"], semanticServer: "ghost", diagnosticServers: ["ghost"] } },
			}),
		);
		const path = session.write("a.ghost", "x\n");

		// when
		const output = await toolCall(session, "apply_patch", update(path), () => writeFileSync(path, "y\n"));

		// then
		const context = contextOf(output);
		expect(context).toContain("Diagnostics incomplete:");
		expect(context).toContain("not installed");
		expect(context).toContain("npm install -g ghost-ls");
	});
});
