import { defineConfig } from "vitest/config";

// Real language servers and toolchains; every required tool must be installed (no silent skips).
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		environment: "node",
		pool: "forks",
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
