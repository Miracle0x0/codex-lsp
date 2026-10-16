import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Position, Range } from "vscode-languageserver-protocol";

/** Public coordinates: 1-based line, 0-based column counted in Unicode code points. */
export interface PublicPosition {
	readonly line: number;
	readonly character: number;
}

export interface PublicRange {
	readonly start: PublicPosition;
	readonly end: PublicPosition;
}

const LINE_BREAK = /\r\n|\r|\n/;

export function splitLines(text: string): string[] {
	return text.split(LINE_BREAK);
}

/** Converts a code-point column to UTF-16 code units within one line. */
export function codePointsToUtf16(line: string, codePoints: number): number {
	let units = 0;
	let counted = 0;
	for (const symbol of line) {
		if (counted >= codePoints) return units;
		units += symbol.length;
		counted += 1;
	}
	return units + Math.max(0, codePoints - counted);
}

/** Converts a UTF-16 column to code points within one line. */
export function utf16ToCodePoints(line: string, units: number): number {
	let consumed = 0;
	let codePoints = 0;
	for (const symbol of line) {
		if (consumed >= units) return codePoints;
		consumed += symbol.length;
		codePoints += 1;
	}
	return codePoints + Math.max(0, units - consumed);
}

/**
 * Maps between public positions and the UTF-16 positions this client negotiates with servers.
 * File text comes from the caller (synced documents) or disk; unreadable files map columns 1:1.
 */
export class PositionMapper {
	private readonly lines = new Map<string, string[] | null>();

	constructor(private readonly knownText: (path: string) => string | undefined = () => undefined) {}

	private lineOf(path: string, line: number): string | undefined {
		let lines = this.lines.get(path);
		if (lines === undefined) {
			const text = this.knownText(path) ?? readText(path);
			lines = text === undefined ? null : splitLines(text);
			this.lines.set(path, lines);
		}
		return lines?.[line];
	}

	toLsp(path: string, position: PublicPosition): Position {
		const line = position.line - 1;
		const text = this.lineOf(path, line);
		return { line, character: text === undefined ? position.character : codePointsToUtf16(text, position.character) };
	}

	toPublicPosition(path: string, position: Position): PublicPosition {
		const text = this.lineOf(path, position.line);
		return {
			line: position.line + 1,
			character: text === undefined ? position.character : utf16ToCodePoints(text, position.character),
		};
	}

	toPublicRange(path: string, range: Range): PublicRange {
		return { start: this.toPublicPosition(path, range.start), end: this.toPublicPosition(path, range.end) };
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function uriToPath(uri: string): string {
	return fileURLToPath(uri);
}
