import { defineConfig } from "vitest/config";

// Real language servers and toolchains. A suite whose tools are missing is skipped with the reason, or fails when
// CODEX_LSP_REQUIRE_TOOLS=1 (CI installs every tool). Conda environments are created by the tests themselves.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		environment: "node",
		pool: "forks",
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 300_000,
	},
});
