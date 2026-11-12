import type { EntryRecord } from "@earendil-works/pi-durable";

import type { ItemRow } from "../db.js";
import { passagesOf } from "../passages.js";

export interface LineageLink {
	conversationId: number;
	throughEntryId: number;
	throughAt: number;
}

export type EntriesReader = (
	query: {
		minEntryId?: number;
		maxEntryId?: number;
		order: "ascending" | "descending";
	},
	limit: number,
	cursor: unknown,
) => Promise<{
	readonly items: readonly EntryRecord[];
	readonly next?: unknown;
}>;

export interface InContextRule {
	lineage: readonly LineageLink[];
	boundary?: { entryId: number; at: number };
}

const PAGE_SIZE = 200;
const lineages = new Map<number, Promise<LineageLink[]>>();

/** Derive each inherited conversation's fork point from the raw entries. */
export async function loadLineage(
	conversationId: number,
	read: EntriesReader,
): Promise<LineageLink[]> {
	let lineage = lineages.get(conversationId);
	if (lineage === undefined) {
		lineage = readLineage(conversationId, read);
		lineages.set(conversationId, lineage);
		lineage.catch(() => lineages.delete(conversationId));
	}
	return lineage;
}

async function readLineage(
	conversationId: number,
	read: EntriesReader,
): Promise<LineageLink[]> {
	const inherited = new Map<number, LineageLink>();
	let cursor: unknown;
	do {
		const page = await read({ order: "ascending" }, PAGE_SIZE, cursor);
		for (const entry of page.items) {
			if (entry.conversationId === conversationId) {
				return [
					...inherited.values(),
					{
						conversationId,
						throughEntryId: Number.POSITIVE_INFINITY,
						throughAt: Number.POSITIVE_INFINITY,
					},
				];
			}
			const throughAt = passagesOf(entry).reduce(
				(latest, passage) => Math.max(latest, passage.at),
				0,
			);
			inherited.set(entry.conversationId, {
				conversationId: entry.conversationId,
				throughEntryId: entry.id,
				throughAt,
			});
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return [
		...inherited.values(),
		{
			conversationId,
			throughEntryId: Number.POSITIVE_INFINITY,
			throughAt: Number.POSITIVE_INFINITY,
		},
	];
}

/** Whether an indexed item is already visible in the request's model context. */
export function inContext(item: ItemRow, rule: InContextRule): boolean {
	const link = rule.lineage.find(
		(candidate) => candidate.conversationId === item.conversationId,
	);
	if (link === undefined) return false;
	if (item.entryId !== null) {
		if (item.entryId > link.throughEntryId) return false;
		return rule.boundary === undefined || item.entryId >= rule.boundary.entryId;
	}
	if (item.at > link.throughAt) return false;
	return rule.boundary === undefined || item.at >= rule.boundary.at;
}
