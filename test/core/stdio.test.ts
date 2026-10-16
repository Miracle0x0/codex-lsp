import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { beforeAll, describe, expect, it } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

beforeAll(() => {
	if (!existsSync(CLI_PATH)) throw new Error(`${CLI_PATH} is missing; run the build before the stdio tests`);
});

describe("lsp-tools-mcp stdio entry", () => {
	it("#given the built CLI #when a 2026-07-28 client connects over stdio #then tools are listed", async () => {
		// given
		const client = new Client({ name: "stdio-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });

		// when
		await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI_PATH, "mcp"] }));
		const { tools } = await client.listTools();
		await client.close();

		// then
		expect(tools.map((tool) => tool.name)).toContain("diagnostics");
	});

	it("#given the built CLI #when a 2025-era initialize arrives on stdin #then it answers with unsupported protocol version", async () => {
		// given
		const child = spawn(process.execPath, [CLI_PATH, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
		const firstLine = new Promise<string>((resolve) => {
			let buffer = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline !== -1) resolve(buffer.slice(0, newline));
			});
		});

		// when
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "0" } },
			})}\n`,
		);
		const response: unknown = JSON.parse(await firstLine);
		child.stdin.end();

		// then
		expect(response).toMatchObject({ id: 1, error: { code: -32022, data: { supported: ["2026-07-28"] } } });
	});
});
