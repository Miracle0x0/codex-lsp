/** One filter of an LSP DocumentSelector; every given field must match. */
export interface DocumentFilter {
	readonly language?: string;
	readonly scheme?: string;
	readonly pattern?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** LSP glob patterns: `*`, `**`, `?`, `{a,b}`, and `[...]` ranges, matched against the whole path. */
export function globToRegExp(pattern: string): RegExp {
	let source = "";
	let braces = 0;
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				const slash = pattern[index + 2] === "/";
				source += slash ? "(?:.*/)?" : ".*";
				index += slash ? 2 : 1;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else if (char === "{") {
			braces += 1;
			source += "(?:";
		} else if (char === "}" && braces > 0) {
			braces -= 1;
			source += ")";
		} else if (char === "," && braces > 0) {
			source += "|";
		} else if (char === "[") {
			const end = pattern.indexOf("]", index + 1);
			if (end === -1) {
				source += "\\[";
			} else {
				const body = pattern
					.slice(index + 1, end)
					.replace(/^!/, "^")
					.replaceAll("\\", "\\\\");
				source += `[${body}]`;
				index = end;
			}
		} else {
			source += char.replace(/[.+^$()|\\/]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

/** Whether a document matches a selector; a missing or malformed selector matches every document. */
export function matchesDocumentSelector(
	selector: unknown,
	document: { readonly path: string; readonly languageId: string },
): boolean {
	if (!Array.isArray(selector)) return true;
	const path = document.path.replaceAll("\\", "/");
	return selector.some((entry) => {
		if (typeof entry === "string") return entry === document.languageId;
		if (!isRecord(entry)) return false;
		if (typeof entry["language"] === "string" && entry["language"] !== document.languageId) return false;
		if (typeof entry["scheme"] === "string" && entry["scheme"] !== "file") return false;
		if (typeof entry["pattern"] === "string" && !globToRegExp(entry["pattern"]).test(path)) return false;
		return true;
	});
}
