import type { EntryRecord } from "@earendil-works/pi-durable";
import type { EmbeddingResult } from "@sigrun/shared/embeddings";

import type { RecallDb } from "./db.js";
import { passagesOf } from "./passages.js";
import { redact } from "./redact.js";
import type { VectorArm } from "./search.js";

/** One row of `host.embeddings.list()` (core's registry shape). */
export interface EmbeddingModelRow {
	/** `provider/model`. */
	readonly model: string;
	readonly provider: string;
	readonly dimensions: number;
	/** Core's gate: the admin listed it AND its provider did not veto. */
	readonly local: boolean;
	/**
	 * True on the one row the live `embeddingModel` setting resolves to.
	 * Every other row carries `false`. Core's published `SigrunHost`
	 * contract declares this (`src/extension.ts`: "True on the one row the
	 * `embeddingModel` setting resolves to"), so recall reads it directly
	 * rather than defending against its absence.
	 */
	readonly default: boolean;
	readonly status: "not_configured" | "degraded" | "ready";
}

/**
 * The `host.embeddings` slice recall uses, declared structurally (the
 * `src/host.ts` discipline the rest of this repo follows): recall never
 * imports core's runtime, only the result type the contract itself names.
 */
export interface EmbeddingHost {
	embed(
		texts: readonly string[],
		opts?: {
			model?: string;
			confidentiality?: "normal" | "local-only";
			signal?: AbortSignal;
			timeoutMs?: number;
		},
	): Promise<EmbeddingResult>;
	list(): Promise<readonly EmbeddingModelRow[]>;
}

export interface VectorIndex {
	upsert(itemId: number, vec: Float32Array): void;
	query(
		vec: Float32Array,
		k: number,
		signal?: AbortSignal,
	): { itemId: number; score: number }[];
}

export type EmbeddingWarning = (code: string, message: string) => void;

/**
 * A per-code warning throttle: a misconfigured provider fails every page
 * and every query, so a per-call log would drown the operator. Each code
 * speaks at most once a minute — long enough to stay quiet, short enough
 * that a transient `failed` cannot go silent for the whole process.
 *
 * `not_local` and `no_model` are expected states (local-only material on a
 * shared model; embeddings simply not configured) and never warn: the
 * items remain lexical, which is the documented behaviour.
 */
export function createEmbeddingWarnings(
	now: () => number = Date.now,
	windowMs = 60_000,
): EmbeddingWarning {
	const last = new Map<string, number>();
	return (code, message) => {
		if (code === "not_local" || code === "no_model") return;
		const at = now();
		const previous = last.get(code);
		if (previous !== undefined && at - previous < windowMs) return;
		last.set(code, at);
		console.warn(`recall: embeddings ${code}; ${message}`);
	};
}

/**
 * The process-wide throttle a caller gets when it does not inject one, so
 * library users and the capture page share ONE budget per code instead of
 * starting a fresh one per call.
 */
export const DEFAULT_EMBEDDING_WARNINGS: EmbeddingWarning = createEmbeddingWarnings();

/** Store vectors in SQLite and scan bounded pages for cosine nearest neighbours. */
export function createSqliteVectorIndex(
	db: RecallDb,
	model: string,
	pageSize = 2000,
): VectorIndex {
	return {
		upsert(itemId, vec) {
			db.upsertVector(itemId, model, vec);
		},
		query(vec, k, signal) {
			if (k <= 0) return [];
			const best: { itemId: number; score: number }[] = [];
			let after = 0;
			for (let page = 0; page < 50; page += 1) {
				if (signal?.aborted === true) break;
				const rows = db.listVectorsPage(model, after, pageSize);
				for (const row of rows) {
					const score = cosine(vec, row.vec);
					best.push({ itemId: row.itemId, score });
					best.sort((a, b) => b.score - a.score);
					if (best.length > k) best.pop();
				}
				if (rows.length < pageSize) break;
				after = rows.at(-1)!.itemId;
			}
			return best;
		},
	};
}

function cosine(left: Float32Array, right: Buffer): number {
	const rightVector = new Float32Array(
		right.buffer.slice(right.byteOffset, right.byteOffset + right.byteLength),
	);
	if (left.length !== rightVector.length) return -1;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index]! * rightVector[index]!;
		leftNorm += left[index]! ** 2;
		rightNorm += rightVector[index]! ** 2;
	}
	if (leftNorm === 0 || rightNorm === 0) return 0;
	return dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * One embedding call for one confidentiality class. `host.embeddings.embed`
 * never throws and splits above the provider's batch size itself, so a page
 * needs exactly one call per class, not a recall-side chunker.
 *
 * `confidentiality: "local-only"` with a model core does not trust for local
 * material comes back `not_local`; the whole batch then stays lexical rather
 * than leaking, which is the documented outcome. Vectors are stored under the
 * model the provider RETURNED, never a recall-side guess.
 */
export async function embedClass(
	embeddings: EmbeddingHost,
	upsert: (itemId: number, model: string, vec: Float32Array) => void,
	batch: readonly { id: number; text: string }[],
	confidentiality: "normal" | "local-only",
	model: string | undefined,
	warn: EmbeddingWarning,
): Promise<void> {
	if (batch.length === 0) return;
	const opts: { confidentiality: "normal" | "local-only"; model?: string } = {
		confidentiality,
	};
	if (model !== undefined) opts.model = model;
	const result = await embeddings.embed(
		batch.map(({ text }) => text),
		opts,
	);
	if (!result.ok) {
		warn(result.code, result.message);
		return;
	}
	for (const [position, vector] of result.vectors.entries()) {
		const candidate = batch[position];
		if (candidate !== undefined) upsert(candidate.id, result.model, vector);
	}
}

/**
 * Embed up to `limit` unembedded conversation passages from their source
 * entries. Local-only items ride `includeLocalOnly` (a model core trusts
 * for local material) and are submitted with `confidentiality:
 * "local-only"`; the rest go as `normal`.
 */
export async function embedPending(
	db: RecallDb,
	embeddings: EmbeddingHost,
	model: string,
	modelIsLocal: boolean,
	entry: (conversationId: number, entryId: number) => Promise<EntryRecord | undefined>,
	limit = 500,
	warn: EmbeddingWarning = DEFAULT_EMBEDDING_WARNINGS,
): Promise<void> {
	const normal: { id: number; text: string }[] = [];
	const local: { id: number; text: string }[] = [];
	for (const item of db.listUnembeddedItems(model, limit, modelIsLocal)) {
		const target = item.cls === "local-only" ? local : normal;
		if (item.kind === "doc") {
			if (item.doc === null) continue;
			const text = db.docText(item.doc, item.offset, item.length);
			if (text !== undefined) target.push({ id: item.id, text });
			continue;
		}
		if (
			item.entryId === null ||
			item.messageIndex === null ||
			item.conversationId === null
		) {
			continue;
		}
		const record = await entry(item.conversationId, item.entryId);
		if (record === undefined) continue;
		const passage = passagesOf(record).find(
			(candidate) =>
				candidate.messageIndex === item.messageIndex &&
				candidate.blockIndex === item.blockIndex &&
				candidate.offset === item.offset,
		);
		if (passage !== undefined) target.push({ id: item.id, text: redact(passage.text) });
	}
	const upsert = (itemId: number, storedModel: string, vec: Float32Array) =>
		db.upsertVector(itemId, storedModel, vec);
	// Same containment as the capture page: the sweep is awaited by a job
	// phase, and a throwing host must leave the remaining items pending for
	// the next pass rather than fail the phase.
	for (const [batch, confidentiality] of [
		[normal, "normal"],
		[local, "local-only"],
	] as const) {
		try {
			await embedClass(embeddings, upsert, batch, confidentiality, model, warn);
		} catch (error) {
			warn(
				"failed",
				`pending passage embedding failed: ${error instanceof Error ? error.message : "unknown error"}`,
			);
		}
	}
}

/**
 * Add a semantic arm over `model`'s index. The QUERY is embedded with
 * that same model — the index is model-scoped, so a query embedded by a
 * different model would compare vectors from two spaces. Failures
 * degrade to lexical search (the vector arm simply contributes nothing).
 */
export function createVectorArm(
	embeddings: EmbeddingHost,
	index: VectorIndex,
	model: string,
	timeoutMs: number,
	warn: EmbeddingWarning = DEFAULT_EMBEDDING_WARNINGS,
): VectorArm {
	return {
		async query(text, candidateLimit) {
			const signal = AbortSignal.timeout(timeoutMs);
			try {
				const result = await embeddings.embed([text], {
					model,
					timeoutMs,
					signal,
				});
				if (!result.ok) {
					warn(result.code, result.message);
					return [];
				}
				const vector = result.vectors[0];
				if (vector === undefined) return [];
				return index.query(vector, candidateLimit, signal).map(({ itemId, score }) => ({
					itemId,
					rank: score,
				}));
			} catch (error) {
				warn(
					"failed",
					error instanceof Error ? error.message : "semantic search unavailable",
				);
				return [];
			}
		},
	};
}
