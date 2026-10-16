import { describe, expect, it } from "vitest";

import { globToRegExp, matchesDocumentSelector } from "../../src/core/lsp/document-selector.js";

describe("document selectors", () => {
	it("#given LSP glob patterns #when matching paths #then **, *, ?, braces, and ranges behave like LSP globs", () => {
		expect(globToRegExp("**/*.rs").test("/w/src/main.rs")).toBe(true);
		expect(globToRegExp("**/*.rs").test("/w/src/main.rsx")).toBe(false);
		expect(globToRegExp("**/Cargo.{toml,lock}").test("/w/Cargo.lock")).toBe(true);
		expect(globToRegExp("/w/*.ts").test("/w/sub/a.ts")).toBe(false);
		expect(globToRegExp("/w/a?.[0-9]").test("/w/ab.7")).toBe(true);
	});

	it("#given filters by pattern, language, and scheme #when matching a file document #then every given field must match", () => {
		const document = { path: "/w/src/main.rs", languageId: "rust" };
		expect(matchesDocumentSelector([{ pattern: "**/*.rs" }], document)).toBe(true);
		expect(matchesDocumentSelector([{ language: "python", pattern: "**/*.rs" }], document)).toBe(false);
		expect(matchesDocumentSelector([{ scheme: "untitled" }], document)).toBe(false);
		expect(matchesDocumentSelector(["rust"], document)).toBe(true);
		expect(matchesDocumentSelector(null, document)).toBe(true);
	});
});
