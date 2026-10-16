import { describe, expect, it } from "vitest";

import { LspProcessExitedError } from "../../src/core/lsp/errors.js";
import { formatKnownLspStartupFailure } from "../../src/core/lsp/utils.js";
import { toToolFailure } from "../../src/core/tools/failures.js";

describe("formatKnownLspStartupFailure", () => {
	it("#given rust-src component conflict #when formatting startup failure #then returns repair guidance", () => {
		// given
		const error = new LspProcessExitedError(
			"rust",
			"/repo",
			1,
			"failed to install component: 'rust-src', detected conflict: 'lib/rustlib/src/rust/library/Cargo.lock'",
		);

		// when
		const message = formatKnownLspStartupFailure(error);

		// then
		expect(message).toContain("rust-analyzer");
		expect(message).toContain("rustup component remove rust-src");
		expect(message).toContain("rustup component add rust-src");
		expect(message).toContain("detected conflict");
		expect(message).toContain("Cargo.lock");
		expect(message).not.toContain("automatic repair");
	});

	it("#given rust-analyzer sysroot error #when classifying the tool failure #then returns server_exited with repair guidance", () => {
		// given
		const error = new LspProcessExitedError(
			"rust",
			"/repo",
			1,
			"can't load standard library from sysroot\ntry installing `rust-src` the same way you installed `rustc`",
		);

		// when
		const failure = toToolFailure(error);
		const message = failure.message;

		// then
		expect(failure.code).toBe("server_exited");
		expect(message).toContain("rustup component remove rust-src");
		expect(message).toContain("rustup component add rust-src");
		expect(message).toContain("can't load standard library");
	});

	it("#given unrelated process exits #when formatting startup failure #then returns null", () => {
		// given
		const typescriptError = new LspProcessExitedError(
			"typescript",
			"/repo",
			1,
			"failed to install component: 'rust-src', detected conflict",
		);
		const rustPanic = new LspProcessExitedError("rust", "/repo", 1, "thread panicked while loading crate graph");

		// when / then
		expect(formatKnownLspStartupFailure(typescriptError)).toBeNull();
		expect(formatKnownLspStartupFailure(rustPanic)).toBeNull();
	});
});
