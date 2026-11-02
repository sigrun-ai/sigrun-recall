import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ItemKind = "turn" | "tool" | "artifact";
export type Confidentiality = "normal" | "local-only";

export interface ItemRow {
	id: number;
	conversationId: number;
	owner: string | null;
	kind: ItemKind;
	entryId: number | null;
	messageIndex: number | null;
	offset: number;
	length: number;
	artifact: string | null;
	job: boolean;
	cls: Confidentiality;
	/** Milliseconds since the Unix epoch: the message's own time. */
	at: number;
	title: string | null;
}

interface StoredItemRow {
	id: number;
	conversationId: number;
	owner: string | null;
	kind: ItemKind;
	entryId: number | null;
	messageIndex: number | null;
	offset: number;
	length: number;
	artifact: string | null;
	job: number;
	cls: Confidentiality;
	at: number;
	title: string | null;
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS items (
		id INTEGER PRIMARY KEY,
		conversationId INTEGER NOT NULL,
		owner TEXT,
		kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'artifact')),
		entryId INTEGER,
		messageIndex INTEGER,
		offset INTEGER NOT NULL,
		length INTEGER NOT NULL,
		artifact TEXT,
		job INTEGER NOT NULL CHECK (job IN (0, 1)),
		cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
		at INTEGER NOT NULL,
		title TEXT
	);
	CREATE UNIQUE INDEX IF NOT EXISTS items_message_key
		ON items (conversationId, kind, entryId, messageIndex, offset)
		WHERE kind IN ('turn', 'tool');
	CREATE UNIQUE INDEX IF NOT EXISTS items_artifact_key
		ON items (artifact, offset)
		WHERE kind = 'artifact';

	CREATE VIRTUAL TABLE IF NOT EXISTS fts_porter
		USING fts5(text, tokenize='porter unicode61', content='');
	CREATE VIRTUAL TABLE IF NOT EXISTS fts_trigram
		USING fts5(text, tokenize='trigram', content='');

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
		block TEXT NOT NULL,
		cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
		PRIMARY KEY (conversationId, messageKey)
	);
	CREATE TABLE IF NOT EXISTS vectors (
		itemId INTEGER PRIMARY KEY,
		dim INTEGER NOT NULL,
		vec BLOB NOT NULL
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
			if (current === undefined || current.version < 1) {
				this.db.exec(SCHEMA);
				if (current === undefined) {
					this.db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
				} else {
					this.db.prepare("UPDATE schema_version SET version = 1").run();
				}
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
						conversationId, owner, kind, entryId, messageIndex, offset,
						length, artifact, job, cls, at, title
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(conversationId, kind, entryId, messageIndex, offset)
						WHERE kind IN ('turn', 'tool') DO NOTHING
					ON CONFLICT(artifact, offset)
						WHERE kind = 'artifact' DO NOTHING
					RETURNING id`,
				)
				.get(
					row.conversationId,
					row.owner,
					row.kind,
					row.entryId,
					row.messageIndex,
					row.offset,
					row.length,
					row.artifact,
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

	item(id: number): ItemRow | undefined {
		const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as
			| StoredItemRow
			| undefined;
		return row === undefined ? undefined : { ...row, job: row.job === 1 };
	}

	/** Item ids matching a trigram FTS5 expression, in match order. */
	matchTrigram(expression: string): number[] {
		// SAFETY: node:sqlite returns plain row objects; this query selects one integer.
		const rows = this.db
			.prepare("SELECT rowid FROM fts_trigram WHERE fts_trigram MATCH ?")
			.all(expression) as unknown as { rowid: number }[];
		return rows.map((row) => row.rowid);
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
	): void {
		this.db
			.prepare(
				`INSERT INTO injections (conversationId, messageKey, block, cls) VALUES (?, ?, ?, ?)
				ON CONFLICT(conversationId, messageKey) DO UPDATE SET
					block = excluded.block, cls = excluded.cls`,
			)
			.run(conversationId, messageKey, block, cls);
	}

	injections(
		conversationId: number,
	): ReadonlyMap<string, { block: string; cls: Confidentiality }> {
		// SAFETY: these rows come from the typed injections schema above.
		const rows = this.db
			.prepare("SELECT messageKey, block, cls FROM injections WHERE conversationId = ?")
			.all(conversationId) as unknown as {
			messageKey: string;
			block: string;
			cls: Confidentiality;
		}[];
		return new Map(rows.map((row) => [row.messageKey, { block: row.block, cls: row.cls }]));
	}

	close(): void {
		this.db.close();
	}
}
