import { describe, expect, it } from "vitest";

import { codePointsToUtf16, utf16ToCodePoints } from "../../src/core/documents/positions.js";
import { applyTextEdits } from "../../src/core/edits/coordinator.js";
import { ToolFailure } from "../../src/core/tools/failures.js";

describe("position encoding", () => {
	it("#given astral and CJK characters #when converting columns #then code points and UTF-16 units round-trip", () => {
		// given
		const line = "const 名前 = '😀😀' + x;";
		const xCodePoints = [...line].indexOf("x");

		// when
		const units = codePointsToUtf16(line, xCodePoints);

		// then
		expect(line.slice(units, units + 1)).toBe("x");
		expect(units).toBe(xCodePoints + 2);
		expect(utf16ToCodePoints(line, units)).toBe(xCodePoints);
	});
});

describe("text edits", () => {
	const range = (line: number, start: number, end: number) => ({
		start: { line, character: start },
		end: { line, character: end },
	});

	it("#given edits on several lines with CRLF endings #when applying #then offsets respect UTF-16 and line breaks", () => {
		// given
		const text = "let 😀a = 1;\r\nuse(a);\r\n";

		// when
		const result = applyTextEdits(
			text,
			[
				{ range: range(0, 6, 7), newText: "renamed" },
				{ range: range(1, 4, 5), newText: "renamed" },
			],
			"/f.ts",
		);

		// then
		expect(result).toBe("let 😀renamed = 1;\r\nuse(renamed);\r\n");
	});

	it("#given overlapping edits #when applying #then nothing is changed and the edit fails", () => {
		// when
		const apply = () =>
			applyTextEdits(
				"abcdef",
				[
					{ range: range(0, 0, 3), newText: "x" },
					{ range: range(0, 2, 4), newText: "y" },
				],
				"/f.ts",
			);

		// then
		expect(apply).toThrow(ToolFailure);
		expect(apply).toThrow(/Overlapping edits/);
	});
});
