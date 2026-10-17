import { defineConfig } from "vitest/config";

// Latency measurements that are printed, never asserted.
export default defineConfig({
	test: {
		include: ["test/perf/**/*.perf.test.ts"],
		environment: "node",
		pool: "forks",
		fileParallelism: false,
		testTimeout: 120_000,
	},
});
