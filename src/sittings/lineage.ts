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

const DEFAULT_PAGE_SIZE = 200;

export type LineageMemo = Map<number, Promise<LineageLink[]>>;

export function createLineageMemo(): LineageMemo {
	return new Map();
}

export interface LoadLineageOptions {
	memo?: LineageMemo;
	pageSize?: number;
}

/**
 * Derive each inherited conversation's fork point from the raw entries.
 * Pass `options.memo` to memoize; without it the memo is throwaway for a
 * one-shot caller, so repeated calls read the entries again.
 */
export async function loadLineage(
	conversationId: number,
	read: EntriesReader,
	options: LoadLineageOptions = {},
): Promise<LineageLink[]> {
	const memo = options.memo ?? createLineageMemo();
	let lineage = memo.get(conversationId);
	if (lineage === undefined) {
		lineage = readLineage(conversationId, read, options.pageSize ?? DEFAULT_PAGE_SIZE);
		memo.set(conversationId, lineage);
		lineage.catch(() => memo.delete(conversationId));
	}
	return lineage;
}

async function readLineage(
	conversationId: number,
	read: EntriesReader,
	pageSize: number,
): Promise<LineageLink[]> {
	const inherited = new Map<number, LineageLink>();
	let cursor: unknown;
	do {
		const page = await read({ order: "ascending" }, pageSize, cursor);
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
			const prior = inherited.get(entry.conversationId)?.throughAt ?? 0;
			const throughAt = passagesOf(entry).reduce(
				(latest, passage) => Math.max(latest, passage.at),
				prior,
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
