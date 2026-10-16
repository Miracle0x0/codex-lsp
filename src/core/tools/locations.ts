import type { Location, LocationLink } from "vscode-languageserver-protocol";

import { type PositionMapper, uriToPath } from "../documents/positions.js";
import type { PublicLocation } from "./schemas.js";

export function toPublicLocation(location: Location | LocationLink, positions: PositionMapper): PublicLocation {
	if ("targetUri" in location) {
		const path = uriToPath(location.targetUri);
		return { path, range: positions.toPublicRange(path, location.targetSelectionRange) };
	}
	const path = uriToPath(location.uri);
	return { path, range: positions.toPublicRange(path, location.range) };
}

export function toLocationList(
	result: Location | LocationLink | ReadonlyArray<Location | LocationLink> | null | undefined,
	positions: PositionMapper,
): PublicLocation[] {
	if (result === null || result === undefined) return [];
	const items: ReadonlyArray<Location | LocationLink> = Array.isArray(result) ? result : [result];
	return items.map((item) => toPublicLocation(item, positions));
}

export function formatPublicLocation(location: PublicLocation): string {
	return `${location.path}:${location.range.start.line}:${location.range.start.character}`;
}
