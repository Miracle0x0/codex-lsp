import { defineConfig } from "vitest/config";

// Real Codex host contract: never part of the default suite. Needs the staged plugin, Codex, its login, network,
// python3, and Pyright; missing prerequisites skip it with the reason, or fail when CODEX_LSP_REQUIRE_TOOLS=1.
export default defineConfig({
	test: {
		include: ["test/contract/**/*.test.ts"],
		environment: "node",
		pool: "forks",
		fileParallelism: false,
		testTimeout: 300_000,
	},
});
