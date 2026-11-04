import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { splitText } from "./passages.js";
import { redact } from "./redact.js";

export type ItemKind = "turn" | "tool" | "artifact" | "doc";
export type Confidentiality = "normal" | "local-only";

export interface ItemRow {
	id: number;
	conversationId: number | null;
	owner: string | null;
	kind: ItemKind;
	entryId: number | null;
	messageIndex: number | null;
	blockIndex: number;
	offset: number;
	length: number;
	artifact: string | null;
	/** docs.id for kind "doc"; null otherwise. */
	doc: number | null;
	job: boolean;
	cls: Confidentiality;
	/** Milliseconds since the Unix epoch: the message's own time. */
	at: number;
	title: string | null;
}

interface StoredItemRow {
	id: number;
	conversationId: number | null;
	owner: string | null;
	kind: ItemKind;
	entryId: number | null;
	messageIndex: number | null;
	blockIndex: number;
	offset: number;
	length: number;
	artifact: string | null;
	doc: number | null;
	job: number;
	cls: Confidentiality;
	at: number;
	title: string | null;
}

export interface DocRow {
	id: number;
	provider: string;
	docId: string;
	owner: string;
	kind: string;
	title: string;
	url: string | null;
	at: number;
	cls: Confidentiality;
	/** Redacted full text; passages slice it for FTS. */
	text: string;
	sources: string[];
	updatedAt: number;
}

interface StoredDocRow {
	id: number;
	provider: string;
	docId: string;
	owner: string;
	kind: string;
	title: string;
	url: string | null;
	at: number;
	cls: Confidentiality;
	text: string;
	sources: string;
	updatedAt: number;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS items (
		id INTEGER PRIMARY KEY,
		conversationId INTEGER,
		owner TEXT,
		kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'artifact', 'doc')),
		entryId INTEGER,
		messageIndex INTEGER,
		blockIndex INTEGER NOT NULL DEFAULT 0,
		offset INTEGER NOT NULL,
		length INTEGER NOT NULL,
		artifact TEXT,
		doc INTEGER,
		job INTEGER NOT NULL CHECK (job IN (0, 1)),
		cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
		at INTEGER NOT NULL,
		title TEXT
	);
	CREATE UNIQUE INDEX IF NOT EXISTS items_message_key
		ON items (conversationId, kind, entryId, messageIndex, blockIndex, offset)
		WHERE kind IN ('turn', 'tool');
	CREATE UNIQUE INDEX IF NOT EXISTS items_artifact_key
		ON items (artifact, offset)
		WHERE kind = 'artifact';
	CREATE UNIQUE INDEX IF NOT EXISTS items_doc_key
		ON items (doc, offset)
		WHERE kind = 'doc';

	CREATE VIRTUAL TABLE IF NOT EXISTS fts_porter
		USING fts5(text, tokenize='porter unicode61', content='');
	CREATE VIRTUAL TABLE IF NOT EXISTS fts_trigram
		USING fts5(text, tokenize='trigram', content='');

	CREATE TABLE IF NOT EXISTS docs (
		id INTEGER PRIMARY KEY,
		provider TEXT NOT NULL,
		docId TEXT NOT NULL,
		owner TEXT NOT NULL,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		url TEXT,
		at INTEGER NOT NULL,
		cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
		text TEXT NOT NULL,
		sources TEXT NOT NULL DEFAULT '[]',
		updatedAt INTEGER NOT NULL,
		UNIQUE (provider, owner, docId)
	);

	CREATE TABLE IF NOT EXISTS artifacts (
		hash TEXT PRIMARY KEY,
		bytes INTEGER NOT NULL,
		title TEXT,
		url TEXT,
		createdAt INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS cursors (
		conversationId INTEGER PRIMARY KEY,
		entryId INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS taint (
		conversationId INTEGER PRIMARY KEY,
		entryId INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS injections (
		conversationId INTEGER NOT NULL,
		messageKey TEXT NOT NULL,
		sources TEXT NOT NULL DEFAULT '[]',
		block TEXT NOT NULL,
		cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
		PRIMARY KEY (conversationId, messageKey)
	);
	CREATE TABLE IF NOT EXISTS vectors (
		itemId INTEGER PRIMARY KEY,
		dim INTEGER NOT NULL,
		vec BLOB NOT NULL
	);
	CREATE TABLE IF NOT EXISTS state (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS schema_version (
		version INTEGER NOT NULL
	);
`;

/** The extension's private SQLite index. Callers close it during shutdown. */
export class RecallDb {
	private constructor(private readonly db: DatabaseSync) {}

	static open(path: string): RecallDb {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const db = new DatabaseSync(path);
		try {
			const migrated = new RecallDb(db);
			migrated.migrate();
			return migrated;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	private migrate(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.exec(
				"CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
			);
			const current = this.db
				.prepare("SELECT version FROM schema_version")
				.get() as { version: number } | undefined;
			if (current === undefined) {
				this.db.exec(SCHEMA);
				this.db.prepare("INSERT INTO schema_version (version) VALUES (3)").run();
			} else if (current.version < 2) {
				const itemColumns = this.db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
				if (!itemColumns.some(({ name }) => name === "blockIndex")) {
					this.db.exec("ALTER TABLE items ADD COLUMN blockIndex INTEGER NOT NULL DEFAULT 0");
				}
				const injectionColumns = this.db.prepare("PRAGMA table_info(injections)").all() as { name: string }[];
				if (!injectionColumns.some(({ name }) => name === "sources")) {
					this.db.exec("ALTER TABLE injections ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'");
				}
				this.db.exec("DROP INDEX items_message_key");
				this.db.exec(SCHEMA);
				this.db.prepare("UPDATE schema_version SET version = 2").run();
			}
			const afterV2 = this.db
				.prepare("SELECT version FROM schema_version")
				.get() as { version: number };
			if (afterV2.version < 3) {
				// Rebuild items with nullable conversationId, the doc column and the
				// widened kind check; ids are preserved so FTS rowids stay valid.
				this.db.exec(`
					ALTER TABLE items RENAME TO items_v2;
					CREATE TABLE items (
						id INTEGER PRIMARY KEY,
						conversationId INTEGER,
						owner TEXT,
						kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'artifact', 'doc')),
						entryId INTEGER,
						messageIndex INTEGER,
						blockIndex INTEGER NOT NULL DEFAULT 0,
						offset INTEGER NOT NULL,
						length INTEGER NOT NULL,
						artifact TEXT,
						doc INTEGER,
						job INTEGER NOT NULL CHECK (job IN (0, 1)),
						cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
						at INTEGER NOT NULL,
						title TEXT
					);
					INSERT INTO items (
						id, conversationId, owner, kind, entryId, messageIndex, blockIndex,
						offset, length, artifact, job, cls, at, title
					)
					SELECT
						id, conversationId, owner, kind, entryId, messageIndex, blockIndex,
						offset, length, artifact, job, cls, at, title
					FROM items_v2;
					DROP TABLE items_v2;
					CREATE UNIQUE INDEX items_message_key
						ON items (conversationId, kind, entryId, messageIndex, blockIndex, offset)
						WHERE kind IN ('turn', 'tool');
					CREATE UNIQUE INDEX items_artifact_key
						ON items (artifact, offset)
						WHERE kind = 'artifact';
					CREATE UNIQUE INDEX items_doc_key
						ON items (doc, offset)
						WHERE kind = 'doc';
					CREATE TABLE IF NOT EXISTS docs (
						id INTEGER PRIMARY KEY,
						provider TEXT NOT NULL,
						docId TEXT NOT NULL,
						owner TEXT NOT NULL,
						kind TEXT NOT NULL,
						title TEXT NOT NULL,
						url TEXT,
						at INTEGER NOT NULL,
						cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
						text TEXT NOT NULL,
						sources TEXT NOT NULL DEFAULT '[]',
						updatedAt INTEGER NOT NULL,
						UNIQUE (provider, owner, docId)
					);
				`);
				this.db.prepare("UPDATE schema_version SET version = 3").run();
			}

			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	insertItem(row: Omit<ItemRow, "id">, text: string): number | undefined {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const inserted = this.db
				.prepare(
				`INSERT INTO items (
					conversationId, owner, kind, entryId, messageIndex, blockIndex, offset,
					length, artifact, doc, job, cls, at, title
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

					ON CONFLICT(conversationId, kind, entryId, messageIndex, blockIndex, offset)
						WHERE kind IN ('turn', 'tool') DO NOTHING
					ON CONFLICT(artifact, offset)
						WHERE kind = 'artifact' DO NOTHING
					ON CONFLICT(doc, offset)
						WHERE kind = 'doc' DO NOTHING
					RETURNING id`,
				)
				.get(
					row.conversationId,
					row.owner,
					row.kind,
					row.entryId,
					row.messageIndex,
					row.blockIndex,
					row.offset,
					row.length,
					row.artifact,
					row.doc,
					row.job ? 1 : 0,
					row.cls,
					row.at,
					row.title,
				) as { id: number } | undefined;
			if (inserted === undefined) {
				this.db.exec("COMMIT");
				return undefined;
			}
			this.db
				.prepare("INSERT INTO fts_porter(rowid, text) VALUES (?, ?)")
				.run(inserted.id, text);
			this.db
				.prepare("INSERT INTO fts_trigram(rowid, text) VALUES (?, ?)")
				.run(inserted.id, text);
			this.db.exec("COMMIT");
			return inserted.id;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Store a user-owned document and index its redacted text as "doc" items.
	 * Identical content, title, date, class and sources leave the store untouched.
	 */
	upsertDoc(
		doc: Omit<DocRow, "id" | "updatedAt">,
		now: number,
	): { id: number; changed: boolean } {
		const text = redact(doc.text);
		const sources = JSON.stringify(doc.sources);
		const existing = this.db
			.prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
			.get(doc.provider, doc.owner, doc.docId) as StoredDocRow | undefined;
		if (
			existing !== undefined &&
			existing.text === text &&
			existing.title === doc.title &&
			existing.at === doc.at &&
			existing.cls === doc.cls &&
			existing.sources === sources
		) {
			return { id: existing.id, changed: false };
		}

		this.db.exec("BEGIN IMMEDIATE");
		try {
			const stored = this.db
				.prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
				.get(doc.provider, doc.owner, doc.docId) as StoredDocRow | undefined;
			if (
				stored !== undefined &&
				stored.text === text &&
				stored.title === doc.title &&
				stored.at === doc.at &&
				stored.cls === doc.cls &&
				stored.sources === sources
			) {
				this.db.exec("COMMIT");
				return { id: stored.id, changed: false };
			}

			let id: number;
			if (stored === undefined) {
				const inserted = this.db
					.prepare(
						`INSERT INTO docs (
							provider, docId, owner, kind, title, url, at, cls, text, sources, updatedAt
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
					)
					.get(
						doc.provider,
						doc.docId,
						doc.owner,
						doc.kind,
						doc.title,
						doc.url,
						doc.at,
						doc.cls,
						text,
						sources,
						now,
					) as { id: number };
				id = inserted.id;
			} else {
				id = stored.id;
				this.deleteDocItems(id, stored.text);
				this.db
					.prepare(
						`UPDATE docs SET
							kind = ?, title = ?, url = ?, at = ?, cls = ?, text = ?, sources = ?, updatedAt = ?
						WHERE id = ?`,
					)
					.run(
						doc.kind,
						doc.title,
						doc.url,
						doc.at,
						doc.cls,
						text,
						sources,
						now,
						id,
					);
			}

			for (const passage of splitText(text)) {
				this.db
					.prepare(
						`INSERT INTO items (
							conversationId, owner, kind, entryId, messageIndex, blockIndex, offset,
							length, artifact, doc, job, cls, at, title
						) VALUES (NULL, ?, 'doc', NULL, NULL, 0, ?, ?, NULL, ?, 0, ?, ?, ?) RETURNING id`,
					)
					.get(
						doc.owner,
						passage.offset,
						passage.text.length,
						id,
						doc.cls,
						doc.at,
						doc.title,
					) as { id: number };
			}
			// SAFETY: the items schema stores integer ids, offsets and lengths.
			const rows = this.db
				.prepare("SELECT id, offset, length FROM items WHERE doc = ? AND kind = 'doc'")
				.all(id) as unknown as { id: number; offset: number; length: number }[];
			for (const row of rows) {
				const passage = text.slice(row.offset, row.offset + row.length);
				this.db
					.prepare("INSERT INTO fts_porter(rowid, text) VALUES (?, ?)")
					.run(row.id, passage);
				this.db
					.prepare("INSERT INTO fts_trigram(rowid, text) VALUES (?, ?)")
					.run(row.id, passage);
			}
			this.db.exec("COMMIT");
			return { id, changed: true };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Delete a document, its items, FTS rows and vectors. */
	removeDoc(provider: string, owner: string, docId: string): boolean {
		const stored = this.db
			.prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
			.get(provider, owner, docId) as StoredDocRow | undefined;
		if (stored === undefined) return false;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.deleteDocItems(stored.id, stored.text);
			this.db.prepare("DELETE FROM docs WHERE id = ?").run(stored.id);
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	doc(id: number): DocRow | undefined {
		const row = this.db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as
			| StoredDocRow
			| undefined;
		return row === undefined ? undefined : docFromStored(row);
	}

	docByKey(provider: string, owner: string, docId: string): DocRow | undefined {
		const row = this.db
			.prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
			.get(provider, owner, docId) as StoredDocRow | undefined;
		return row === undefined ? undefined : docFromStored(row);
	}

	/** A slice of a document's stored redacted text, matching its passage rows. */
	docText(id: number, offset: number, length: number): string | undefined {
		const row = this.db
			.prepare("SELECT text FROM docs WHERE id = ?")
			.get(id) as { text: string } | undefined;
		return row === undefined ? undefined : row.text.slice(offset, offset + length);
	}

	/** Delete a document's items, removing their FTS rows and vectors first. */
	private deleteDocItems(docId: number, text: string): void {
		// SAFETY: the items schema stores integer ids, offsets and lengths.
		const rows = this.db
			.prepare("SELECT id, offset, length FROM items WHERE doc = ? AND kind = 'doc'")
			.all(docId) as unknown as { id: number; offset: number; length: number }[];
		for (const row of rows) {
			const passage = text.slice(row.offset, row.offset + row.length);
			this.db
				.prepare("INSERT INTO fts_porter(fts_porter, rowid, text) VALUES ('delete', ?, ?)")
				.run(row.id, passage);
			this.db
				.prepare("INSERT INTO fts_trigram(fts_trigram, rowid, text) VALUES ('delete', ?, ?)")
				.run(row.id, passage);
			this.db.prepare("DELETE FROM vectors WHERE itemId = ?").run(row.id);
		}
		this.db.prepare("DELETE FROM items WHERE doc = ? AND kind = 'doc'").run(docId);
	}

	putArtifact(
		hash: string,
		bytes: number,
		meta: { title?: string; url?: string; createdAt: number },
	): void {
		this.db
			.prepare(
				`INSERT INTO artifacts (hash, bytes, title, url, createdAt)
				 VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
			)
			.run(hash, bytes, meta.title ?? null, meta.url ?? null, meta.createdAt);
	}

	item(id: number): ItemRow | undefined {
		const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as
			| StoredItemRow
			| undefined;
		return row === undefined ? undefined : { ...row, job: row.job === 1 };
	}

	itemByPassage(
		conversationId: number,
		entryId: number,
		messageIndex: number,
		blockIndex: number,
		offset: number,
	): ItemRow | undefined {
		const row = this.db
			.prepare(
				`SELECT * FROM items WHERE conversationId = ? AND entryId = ?
				 AND messageIndex = ? AND blockIndex = ? AND offset = ? AND kind IN ('turn', 'tool')`,
			)
			.get(conversationId, entryId, messageIndex, blockIndex, offset) as StoredItemRow | undefined;
		return row === undefined ? undefined : { ...row, job: row.job === 1 };
	}

	itemsForEntries(conversationId: number, entryIds: readonly number[]): ItemRow[] {
		if (entryIds.length === 0) return [];
		const placeholders = entryIds.map(() => "?").join(",");
		// SAFETY: placeholders are generated from array length; values are bound.
		const rows = this.db
			.prepare(
				`SELECT * FROM items WHERE conversationId = ? AND entryId IN (${placeholders})`,
			)
			.all(conversationId, ...entryIds) as unknown as StoredItemRow[];
		return rows.map((row) => ({ ...row, job: row.job === 1 }));
	}

	artifactHash(handle: string): string | undefined {
		const row = this.db
			.prepare("SELECT hash FROM artifacts WHERE substr(hash, 1, 16) = ?")
			.get(handle.slice(2)) as { hash: string } | undefined;
		return row?.hash;
	}

	itemByArtifact(handle: string): ItemRow | undefined {
		const row = this.db
			.prepare("SELECT * FROM items WHERE artifact = ? ORDER BY id LIMIT 1")
			.get(handle) as StoredItemRow | undefined;
		return row === undefined ? undefined : { ...row, job: row.job === 1 };
	}

	searchPorter(query: string, limit: number): { id: number; bm25: number }[] {
		return this.searchFts("fts_porter", query, limit);
	}

	searchTrigram(query: string, limit: number): { id: number; bm25: number }[] {
		return this.searchFts("fts_trigram", query, limit);
	}

	private searchFts(
		table: "fts_porter" | "fts_trigram",
		query: string,
		limit: number,
	): { id: number; bm25: number }[] {
		// SAFETY: table is an internal two-value union; values are bound parameters.
		// The query selects one integer id and one numeric bm25 rank per row.
		const rows = this.db
			.prepare(
				`SELECT rowid AS id, bm25(${table}) AS rank FROM ${table}
				 WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`,
			)
			.all(query, limit) as unknown as { id: number; rank: number }[];
		return rows.map(({ id, rank }) => ({ id, bm25: rank }));
	}

	/** Indexed text for one item from the porter FTS table. */
	itemText(id: number): string | undefined {
		const row = this.db
			.prepare("SELECT text FROM fts_porter WHERE rowid = ?")
			.get(id) as { text: string } | undefined;
		return row?.text;
	}

	/** Item ids matching a trigram FTS5 expression, in match order. */
	matchTrigram(expression: string): number[] {
		// SAFETY: node:sqlite returns plain row objects; this query selects one integer.
		const rows = this.db
			.prepare("SELECT rowid FROM fts_trigram WHERE fts_trigram MATCH ?")
			.all(expression) as unknown as { rowid: number }[];
		return rows.map((row) => row.rowid);
	}

	upsertVector(itemId: number, vec: Float32Array): void {
		const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
		this.db
			.prepare(
				`INSERT INTO vectors (itemId, dim, vec) VALUES (?, ?, ?)
				 ON CONFLICT(itemId) DO UPDATE SET dim = excluded.dim, vec = excluded.vec`,
			)
			.run(itemId, vec.length, bytes);
	}

	listVectorsPage(after: number, limit: number): { itemId: number; vec: Buffer }[] {
		// SAFETY: the vectors schema stores integer item ids and Float32 BLOB bytes.
		return this.db
			.prepare(
				"SELECT itemId, vec FROM vectors WHERE itemId > ? ORDER BY itemId LIMIT ?",
			)
			.all(after, limit) as unknown as { itemId: number; vec: Buffer }[];
	}

	state(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	setState(key: string, value: string): void {
		this.db
			.prepare(
				"INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, value);
	}

	listUnembeddedItems(limit: number, includeLocalOnly: boolean): ItemRow[] {
		// SAFETY: the LEFT JOIN projects the typed items schema only.
		const rows = this.db
			.prepare(
				`SELECT items.* FROM items LEFT JOIN vectors ON vectors.itemId = items.id
				 WHERE vectors.itemId IS NULL AND items.kind IN ('turn', 'tool')
				 AND items.entryId IS NOT NULL AND items.messageIndex IS NOT NULL
				 AND (? OR items.cls != 'local-only') ORDER BY items.id LIMIT ?`,
			)
			.all(includeLocalOnly ? 1 : 0, limit) as unknown as StoredItemRow[];
		return rows.map((row) => ({ ...row, job: row.job === 1 }));
	}

	cursor(conversationId: number): number | undefined {
		return this.entryId("cursors", conversationId);
	}

	setCursor(conversationId: number, entryId: number): void {
		this.setEntryId("cursors", conversationId, entryId);
	}

	taintFrom(conversationId: number): number | undefined {
		return this.entryId("taint", conversationId);
	}

	setTaint(conversationId: number, entryId: number): void {
		// The earliest point wins: everything from it onward stays local-only.
		this.db
			.prepare(
				`INSERT INTO taint (conversationId, entryId) VALUES (?, ?)
				ON CONFLICT(conversationId) DO UPDATE SET entryId = excluded.entryId
				WHERE excluded.entryId < taint.entryId`,
			)
			.run(conversationId, entryId);
	}

	private entryId(table: "cursors" | "taint", conversationId: number): number | undefined {
		const row = this.db
			.prepare(`SELECT entryId FROM ${table} WHERE conversationId = ?`)
			.get(conversationId) as { entryId: number } | undefined;
		return row?.entryId;
	}

	private setEntryId(table: "cursors" | "taint", conversationId: number, entryId: number): void {
		this.db
			.prepare(
				`INSERT INTO ${table} (conversationId, entryId) VALUES (?, ?)
				ON CONFLICT(conversationId) DO UPDATE SET entryId = excluded.entryId`,
			)
			.run(conversationId, entryId);
	}

	putInjection(
		conversationId: number,
		messageKey: string,
		block: string,
		cls: Confidentiality,
		sources: readonly number[] = [],
	): void {
		this.db
			.prepare(
				`INSERT INTO injections (conversationId, messageKey, block, cls, sources) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(conversationId, messageKey) DO UPDATE SET
					block = excluded.block, cls = excluded.cls, sources = excluded.sources`,
			)
			.run(conversationId, messageKey, block, cls, JSON.stringify(sources));
	}

	injections(
		conversationId: number,
	): ReadonlyMap<string, { block: string; cls: Confidentiality; sources: number[] }> {
		// SAFETY: these rows come from the typed injections schema above.
		const rows = this.db
			.prepare("SELECT messageKey, block, cls, sources FROM injections WHERE conversationId = ?")
			.all(conversationId) as unknown as {
			messageKey: string;
			block: string;
			cls: Confidentiality;
			sources: string;
		}[];
		return new Map(rows.map((row) => {
			const parsed: unknown = JSON.parse(row.sources);
			const sources = Array.isArray(parsed)
				? parsed.filter((id): id is number => Number.isInteger(id) && id > 0)
				: [];
			return [row.messageKey, { block: row.block, cls: row.cls, sources }];
		}));
	}

	close(): void {
		this.db.close();
	}
}

function docFromStored(row: StoredDocRow): DocRow {
	const parsed: unknown = JSON.parse(row.sources);
	const sources = Array.isArray(parsed)
		? parsed.filter((source): source is string => typeof source === "string")
		: [];
	return { ...row, sources };
}
