import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitText } from "./passages.js";
import { redact } from "./redact.js";
const SITTINGS_SCHEMA = `
	CREATE TABLE IF NOT EXISTS sitting_decisions (
		conversationId INTEGER NOT NULL,
		entryId INTEGER NOT NULL,
		boundary INTEGER NOT NULL CHECK (boundary IN (0, 1)),
		PRIMARY KEY (conversationId, entryId)
	);
	CREATE TABLE IF NOT EXISTS sittings (
		conversationId INTEGER NOT NULL,
		startEntryId INTEGER NOT NULL,
		startAt INTEGER NOT NULL,
		boundary INTEGER NOT NULL CHECK (boundary IN (0, 1)),
		boundaryText TEXT NOT NULL DEFAULT '',
		previous TEXT,
		block TEXT,
		title TEXT,
		titleState TEXT NOT NULL DEFAULT 'none' CHECK (titleState IN ('pending', 'done', 'failed', 'none')),
		PRIMARY KEY (conversationId, startEntryId)
	);
	CREATE TABLE IF NOT EXISTS sitting_lines (
		conversationId INTEGER NOT NULL,
		startEntryId INTEGER NOT NULL,
		text TEXT NOT NULL,
		cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
		coversThrough INTEGER NOT NULL,
		sealed INTEGER NOT NULL CHECK (sealed IN (0, 1)),
		PRIMARY KEY (conversationId, startEntryId)
	);
	CREATE TABLE IF NOT EXISTS month_lines (
		conversationId INTEGER NOT NULL,
		month TEXT NOT NULL,
		text TEXT NOT NULL,
		cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
		PRIMARY KEY (conversationId, month)
	);
`;
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
		itemId INTEGER NOT NULL,
		model TEXT NOT NULL,
		dim INTEGER NOT NULL,
		vec BLOB NOT NULL,
		PRIMARY KEY (itemId, model)
	);
	CREATE TABLE IF NOT EXISTS state (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	${SITTINGS_SCHEMA}
	CREATE TABLE IF NOT EXISTS schema_version (
		version INTEGER NOT NULL
	);
`;
/**
 * The extension's private SQLite index. Callers close it during shutdown.
 *
 * `labelModel` is the model the v4 migration stamps on the vectors it
 * inherits from the pre-model schema: the caller passes
 * `openai/<old embedding model>` only when the old settings named a
 * model AND pointed at [OI]'s own endpoint (config's `migrationLabel`).
 * Without a label those rows land under `model = ""` — a key no real
 * model has, so they are re-embedded and later deleted.
 */
export class RecallDb {
    db;
    constructor(db) {
        this.db = db;
    }
    static open(path, labelModel) {
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true });
        const db = new DatabaseSync(path);
        try {
            const migrated = new RecallDb(db);
            migrated.migrate(labelModel);
            return migrated;
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    migrate(labelModel) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
            const current = this.db
                .prepare("SELECT version FROM schema_version")
                .get();
            if (current === undefined) {
                this.db.exec(SCHEMA);
                // Stamped 3 so the v4 rebuild below runs on this path too: a
                // database with tables but no version row may carry the OLD
                // vectors shape, and SCHEMA's `IF NOT EXISTS` never reshapes it.
                // The v5 step below is idempotent against SCHEMA's fresh tables.
                this.db.prepare("INSERT INTO schema_version (version) VALUES (3)").run();
            }
            else if (current.version < 2) {
                const itemColumns = this.db.prepare("PRAGMA table_info(items)").all();
                if (!itemColumns.some(({ name }) => name === "blockIndex")) {
                    this.db.exec("ALTER TABLE items ADD COLUMN blockIndex INTEGER NOT NULL DEFAULT 0");
                }
                // The shared SCHEMA references the v3 doc column; the v3 rebuild below restates it.
                if (!itemColumns.some(({ name }) => name === "doc")) {
                    this.db.exec("ALTER TABLE items ADD COLUMN doc INTEGER");
                }
                const injectionColumns = this.db.prepare("PRAGMA table_info(injections)").all();
                if (!injectionColumns.some(({ name }) => name === "sources")) {
                    this.db.exec("ALTER TABLE injections ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'");
                }
                this.db.exec("DROP INDEX items_message_key");
                this.db.exec(SCHEMA);
                this.db.prepare("UPDATE schema_version SET version = 2").run();
            }
            const afterV2 = this.db
                .prepare("SELECT version FROM schema_version")
                .get();
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
            const afterV3 = this.db
                .prepare("SELECT version FROM schema_version")
                .get();
            if (afterV3.version < 4) {
                // Rebuild vectors keyed by (itemId, model) so vectors from two
                // models can never be compared. Inherited rows carry the label the
                // caller derived from the old settings (or "", never a real
                // model). The table may be absent (a pre-v3 fixture) or already
                // carry `model` (SCHEMA's fresh create) — both must be idempotent.
                const vectorColumns = this.db
                    .prepare("PRAGMA table_info(vectors)")
                    .all();
                if (vectorColumns.length === 0) {
                    this.db.exec(`
						CREATE TABLE vectors (
							itemId INTEGER NOT NULL,
							model TEXT NOT NULL,
							dim INTEGER NOT NULL,
							vec BLOB NOT NULL,
							PRIMARY KEY (itemId, model)
						);
					`);
                }
                else if (!vectorColumns.some(({ name }) => name === "model")) {
                    this.db.exec(`
						ALTER TABLE vectors RENAME TO vectors_v3;
						CREATE TABLE vectors (
							itemId INTEGER NOT NULL,
							model TEXT NOT NULL,
							dim INTEGER NOT NULL,
							vec BLOB NOT NULL,
							PRIMARY KEY (itemId, model)
						);
					`);
                    this.db
                        .prepare(`INSERT INTO vectors (itemId, model, dim, vec)
							 SELECT itemId, ?, dim, vec FROM vectors_v3`)
                        .run(labelModel ?? "");
                    this.db.exec("DROP TABLE vectors_v3");
                }
                // The model-scoped page scan is `model = ? AND itemId > ?`, so the
                // (model, itemId) index makes it a range scan even mid-switch.
                this.db.exec("CREATE INDEX IF NOT EXISTS vectors_model ON vectors (model, itemId)");
                this.db.prepare("UPDATE schema_version SET version = 4").run();
            }
            const afterV4 = this.db
                .prepare("SELECT version FROM schema_version")
                .get();
            if (afterV4.version < 5) {
                // The four sittings tables are all new: no rows to migrate.
                // `IF NOT EXISTS` makes this idempotent against SCHEMA's fresh
                // create, so a fresh database stamped through v4 also passes
                // through here cleanly.
                this.db.exec(SITTINGS_SCHEMA);
                this.db.prepare("UPDATE schema_version SET version = 5").run();
            }
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    insertItem(row, text) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const inserted = this.db
                .prepare(`INSERT INTO items (
					conversationId, owner, kind, entryId, messageIndex, blockIndex, offset,
					length, artifact, doc, job, cls, at, title
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

					ON CONFLICT(conversationId, kind, entryId, messageIndex, blockIndex, offset)
						WHERE kind IN ('turn', 'tool') DO NOTHING
					ON CONFLICT(artifact, offset)
						WHERE kind = 'artifact' DO NOTHING
					ON CONFLICT(doc, offset)
						WHERE kind = 'doc' DO NOTHING
					RETURNING id`)
                .get(row.conversationId, row.owner, row.kind, row.entryId, row.messageIndex, row.blockIndex, row.offset, row.length, row.artifact, row.doc, row.job ? 1 : 0, row.cls, row.at, row.title);
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
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    /**
     * Store a user-owned document and index its redacted text as "doc" items.
     * Identical content, title, date, class and sources leave the store untouched.
     */
    upsertDoc(doc, now) {
        const text = redact(doc.text);
        const sources = JSON.stringify(doc.sources);
        const existing = this.db
            .prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
            .get(doc.provider, doc.owner, doc.docId);
        if (existing !== undefined &&
            existing.text === text &&
            existing.title === doc.title &&
            existing.at === doc.at &&
            existing.cls === doc.cls &&
            existing.sources === sources) {
            return { id: existing.id, changed: false };
        }
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const stored = this.db
                .prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
                .get(doc.provider, doc.owner, doc.docId);
            if (stored !== undefined &&
                stored.text === text &&
                stored.title === doc.title &&
                stored.at === doc.at &&
                stored.cls === doc.cls &&
                stored.sources === sources) {
                this.db.exec("COMMIT");
                return { id: stored.id, changed: false };
            }
            let id;
            if (stored === undefined) {
                const inserted = this.db
                    .prepare(`INSERT INTO docs (
							provider, docId, owner, kind, title, url, at, cls, text, sources, updatedAt
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
                    .get(doc.provider, doc.docId, doc.owner, doc.kind, doc.title, doc.url, doc.at, doc.cls, text, sources, now);
                id = inserted.id;
            }
            else {
                id = stored.id;
                this.deleteDocItems(id, stored.text);
                this.db
                    .prepare(`UPDATE docs SET
							kind = ?, title = ?, url = ?, at = ?, cls = ?, text = ?, sources = ?, updatedAt = ?
						WHERE id = ?`)
                    .run(doc.kind, doc.title, doc.url, doc.at, doc.cls, text, sources, now, id);
            }
            for (const passage of splitText(text)) {
                this.db
                    .prepare(`INSERT INTO items (
							conversationId, owner, kind, entryId, messageIndex, blockIndex, offset,
							length, artifact, doc, job, cls, at, title
						) VALUES (NULL, ?, 'doc', NULL, NULL, 0, ?, ?, NULL, ?, 0, ?, ?, ?) RETURNING id`)
                    .get(doc.owner, passage.offset, passage.text.length, id, doc.cls, doc.at, doc.title);
            }
            // SAFETY: the items schema stores integer ids, offsets and lengths.
            const rows = this.db
                .prepare("SELECT id, offset, length FROM items WHERE doc = ? AND kind = 'doc'")
                .all(id);
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
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    /** Delete a document, its items, FTS rows and vectors. */
    removeDoc(provider, owner, docId) {
        const stored = this.db
            .prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
            .get(provider, owner, docId);
        if (stored === undefined)
            return false;
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.deleteDocItems(stored.id, stored.text);
            this.db.prepare("DELETE FROM docs WHERE id = ?").run(stored.id);
            this.db.exec("COMMIT");
            return true;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    doc(id) {
        const row = this.db.prepare("SELECT * FROM docs WHERE id = ?").get(id);
        return row === undefined ? undefined : docFromStored(row);
    }
    docByKey(provider, owner, docId) {
        const row = this.db
            .prepare("SELECT * FROM docs WHERE provider = ? AND owner = ? AND docId = ?")
            .get(provider, owner, docId);
        return row === undefined ? undefined : docFromStored(row);
    }
    /** A slice of a document's stored redacted text, matching its passage rows. */
    docText(id, offset, length) {
        const row = this.db
            .prepare("SELECT text FROM docs WHERE id = ?")
            .get(id);
        return row === undefined ? undefined : row.text.slice(offset, offset + length);
    }
    /** Delete a document's items, removing their FTS rows and vectors first. */
    deleteDocItems(docId, text) {
        // SAFETY: the items schema stores integer ids, offsets and lengths.
        const rows = this.db
            .prepare("SELECT id, offset, length FROM items WHERE doc = ? AND kind = 'doc'")
            .all(docId);
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
    putArtifact(hash, bytes, meta) {
        this.db
            .prepare(`INSERT INTO artifacts (hash, bytes, title, url, createdAt)
				 VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`)
            .run(hash, bytes, meta.title ?? null, meta.url ?? null, meta.createdAt);
    }
    item(id) {
        const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id);
        return row === undefined ? undefined : { ...row, job: row.job === 1 };
    }
    itemByPassage(conversationId, entryId, messageIndex, blockIndex, offset) {
        const row = this.db
            .prepare(`SELECT * FROM items WHERE conversationId = ? AND entryId = ?
				 AND messageIndex = ? AND blockIndex = ? AND offset = ? AND kind IN ('turn', 'tool')`)
            .get(conversationId, entryId, messageIndex, blockIndex, offset);
        return row === undefined ? undefined : { ...row, job: row.job === 1 };
    }
    itemsForEntries(conversationId, entryIds) {
        if (entryIds.length === 0)
            return [];
        const placeholders = entryIds.map(() => "?").join(",");
        // SAFETY: placeholders are generated from array length; values are bound.
        const rows = this.db
            .prepare(`SELECT * FROM items WHERE conversationId = ? AND entryId IN (${placeholders})`)
            .all(conversationId, ...entryIds);
        return rows.map((row) => ({ ...row, job: row.job === 1 }));
    }
    artifactHash(handle) {
        const row = this.db
            .prepare("SELECT hash FROM artifacts WHERE substr(hash, 1, 16) = ?")
            .get(handle.slice(2));
        return row?.hash;
    }
    itemByArtifact(handle) {
        const row = this.db
            .prepare("SELECT * FROM items WHERE artifact = ? ORDER BY id LIMIT 1")
            .get(handle);
        return row === undefined ? undefined : { ...row, job: row.job === 1 };
    }
    /** The first passage item of a document, for "d:<id>" handle resolution. */
    itemByDoc(doc) {
        const row = this.db
            .prepare("SELECT * FROM items WHERE doc = ? ORDER BY id LIMIT 1")
            .get(doc);
        return row === undefined ? undefined : { ...row, job: row.job === 1 };
    }
    searchPorter(query, limit) {
        return this.searchFts("fts_porter", query, limit);
    }
    searchTrigram(query, limit) {
        return this.searchFts("fts_trigram", query, limit);
    }
    searchFts(table, query, limit) {
        // SAFETY: table is an internal two-value union; values are bound parameters.
        // The query selects one integer id and one numeric bm25 rank per row.
        const rows = this.db
            .prepare(`SELECT rowid AS id, bm25(${table}) AS rank FROM ${table}
				 WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`)
            .all(query, limit);
        return rows.map(({ id, rank }) => ({ id, bm25: rank }));
    }
    /** Indexed text for one item from the porter FTS table. */
    itemText(id) {
        const row = this.db
            .prepare("SELECT text FROM fts_porter WHERE rowid = ?")
            .get(id);
        return row?.text;
    }
    /** Item ids matching a trigram FTS5 expression, in match order. */
    matchTrigram(expression) {
        // SAFETY: node:sqlite returns plain row objects; this query selects one integer.
        const rows = this.db
            .prepare("SELECT rowid FROM fts_trigram WHERE fts_trigram MATCH ?")
            .all(expression);
        return rows.map((row) => row.rowid);
    }
    upsertVector(itemId, model, vec) {
        const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
        this.db
            .prepare(`INSERT INTO vectors (itemId, model, dim, vec) VALUES (?, ?, ?, ?)
				 ON CONFLICT(itemId, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec`)
            .run(itemId, model, vec.length, bytes);
    }
    itemOwners() {
        const rows = this.db
            .prepare("SELECT DISTINCT owner FROM items ORDER BY owner")
            .all();
        return rows.map(({ owner }) => owner);
    }
    listVectorsPage(model, after, limit, owner) {
        const scoped = owner !== undefined;
        const rows = this.db
            .prepare(`SELECT vectors.itemId, vectors.vec FROM vectors
				 JOIN items ON items.id = vectors.itemId
				 WHERE vectors.model = ? AND vectors.itemId > ?
				 AND (? OR items.owner IS ?)
				 ORDER BY vectors.itemId LIMIT ?`)
            .all(model, after, scoped ? 0 : 1, scoped ? owner : null, limit);
        // SAFETY: the vectors/items schemas store integer ids and Float32 BLOB bytes.
        // The optional owner keeps whole-model inspection available; semantic
        // query indexes always supply it, including NULL.
        return rows;
    }
    /**
     * Drop one owner's vectors that are not the given model's — the switch's
     * cleanup: only called once the new model covers that owner's items.
     */
    deleteVectorsExcept(model, owner) {
        if (owner === undefined) {
            this.db.prepare("DELETE FROM vectors WHERE model != ?").run(model);
            return;
        }
        this.db
            .prepare(`DELETE FROM vectors WHERE model != ? AND itemId IN (
				 SELECT id FROM items WHERE owner IS ?)`)
            .run(model, owner);
    }
    state(key) {
        const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key);
        return row?.value;
    }
    setState(key, value) {
        this.db
            .prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(key, value);
    }
    /**
     * Items with no vector for `model` — the embedPending work list. Items a
     * model may never embed (a non-local model's local-only items) are
     * filtered out by `includeLocalOnly`, not treated as pending. `after`
     * pages by item id for {@link modelCoverage}'s bounded scan.
     */
    listUnembeddedItems(model, limit, includeLocalOnly, after = 0, owner) {
        const scoped = owner !== undefined;
        const rows = this.db
            .prepare(`SELECT items.* FROM items
				 LEFT JOIN vectors ON vectors.itemId = items.id AND vectors.model = ?
				 WHERE vectors.itemId IS NULL AND items.id > ?
				 AND items.kind IN ('turn', 'tool', 'doc')
				 AND (items.kind = 'doc' OR (items.entryId IS NOT NULL AND items.messageIndex IS NOT NULL))
				 AND (? OR items.cls != 'local-only')
				 AND (? OR items.owner IS ?) ORDER BY items.id LIMIT ?`)
            .all(model, after, includeLocalOnly ? 1 : 0, scoped ? 0 : 1, scoped ? owner : null, limit);
        // SAFETY: the LEFT JOIN projects the typed items schema only.
        return rows.map((row) => ({
            ...row,
            job: row.job === 1,
        }));
    }
    /**
     * Whether the sweep could embed this item at all: a document item whose
     * document still exists, or a turn/tool item whose entry is addressable.
     * This is the structural "dangling" class {@link modelCoverage}
     * subtracts, and the same class `embedPending` skips — so the coverage
     * probe can never call an item covered that the sweep would refuse.
     *
     * Runtime skips are NOT dangling: an entry that fails to load or a
     * passage that no longer matches stays pending, so both the sweep and
     * the probe retry it rather than declare it done.
     */
    embeddable(item) {
        if (item.kind === "doc") {
            return item.doc !== null && this.docExists(item.doc);
        }
        return (item.conversationId !== null &&
            item.entryId !== null &&
            item.messageIndex !== null);
    }
    docExists(doc) {
        return this.db.prepare("SELECT 1 FROM docs WHERE id = ?").get(doc) !== undefined;
    }
    /**
     * Whether `model` has a vector for every item it can embed: the eligible
     * list `listUnembeddedItems` returns, minus the items `embeddable` calls
     * structurally dangling, is empty. Local-only items a non-local model may
     * never embed are not counted against it (`includeLocalOnly`, exactly as
     * for the sweep).
     *
     * The caller deletes the previous model's rows once this says complete,
     * which is irreversible — so the probe returns `complete: false` the
     * moment ONE embeddable item lacks a vector, and gives up (also `false`)
     * rather than guess when the dangling backlog exceeds its bounded scan.
     */
    modelCoverage(model, includeLocalOnly, owner) {
        const PAGE = 200;
        const MAX_PAGES = 25;
        let after = 0;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const rows = this.listUnembeddedItems(model, PAGE, includeLocalOnly, after, owner);
            for (const item of rows) {
                if (this.embeddable(item))
                    return { complete: false };
            }
            if (rows.length < PAGE)
                return { complete: true };
            after = rows.at(-1).id;
        }
        return { complete: false };
    }
    cursor(conversationId) {
        return this.entryId("cursors", conversationId);
    }
    setCursor(conversationId, entryId) {
        this.setEntryId("cursors", conversationId, entryId);
    }
    taintFrom(conversationId) {
        return this.entryId("taint", conversationId);
    }
    setTaint(conversationId, entryId) {
        // The earliest point wins: everything from it onward stays local-only.
        this.db
            .prepare(`INSERT INTO taint (conversationId, entryId) VALUES (?, ?)
				ON CONFLICT(conversationId) DO UPDATE SET entryId = excluded.entryId
				WHERE excluded.entryId < taint.entryId`)
            .run(conversationId, entryId);
    }
    entryId(table, conversationId) {
        const row = this.db
            .prepare(`SELECT entryId FROM ${table} WHERE conversationId = ?`)
            .get(conversationId);
        return row?.entryId;
    }
    setEntryId(table, conversationId, entryId) {
        this.db
            .prepare(`INSERT INTO ${table} (conversationId, entryId) VALUES (?, ?)
				ON CONFLICT(conversationId) DO UPDATE SET entryId = excluded.entryId`)
            .run(conversationId, entryId);
    }
    putInjection(conversationId, messageKey, block, cls, sources = []) {
        this.db
            .prepare(`INSERT INTO injections (conversationId, messageKey, block, cls, sources) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(conversationId, messageKey) DO UPDATE SET
					block = excluded.block, cls = excluded.cls, sources = excluded.sources`)
            .run(conversationId, messageKey, block, cls, JSON.stringify(sources));
    }
    injections(conversationId) {
        // SAFETY: these rows come from the typed injections schema above.
        const rows = this.db
            .prepare("SELECT messageKey, block, cls, sources FROM injections WHERE conversationId = ?")
            .all(conversationId);
        return new Map(rows.map((row) => {
            const parsed = JSON.parse(row.sources);
            const sources = Array.isArray(parsed)
                ? parsed.filter((id) => Number.isInteger(id) && id > 0)
                : [];
            return [row.messageKey, { block: row.block, cls: row.cls, sources }];
        }));
    }
    // --- Sittings (v5) ---
    /** Read a stored boundary decision. `undefined` = never decided. */
    decision(conversationId, entryId) {
        const row = this.db
            .prepare("SELECT boundary FROM sitting_decisions WHERE conversationId = ? AND entryId = ?")
            .get(conversationId, entryId);
        return row === undefined ? undefined : row.boundary === 1;
    }
    /** Stores a boundary decision; in practice callers record negatives, but the boolean round-trips. */
    putDecision(conversationId, entryId, boundary) {
        this.db
            .prepare(`INSERT INTO sitting_decisions (conversationId, entryId, boundary) VALUES (?, ?, ?)
				 ON CONFLICT(conversationId, entryId) DO UPDATE SET boundary = excluded.boundary`)
            .run(conversationId, entryId, boundary ? 1 : 0);
    }
    /**
     * ONE transaction: positive decision + sitting row insert + previous line seal.
     * Returns `false` and writes NOTHING when a sitting row already exists for
     * (conversationId, startEntryId) — re-entrancy guard for `beforeRequest`.
     */
    createBoundary(row, sealPrevious) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.db
                .prepare("SELECT 1 FROM sittings WHERE conversationId = ? AND startEntryId = ?")
                .get(row.conversationId, row.startEntryId);
            if (existing !== undefined) {
                this.db.exec("COMMIT");
                return false;
            }
            this.db
                .prepare(`INSERT INTO sitting_decisions (conversationId, entryId, boundary) VALUES (?, ?, 1)
					 ON CONFLICT(conversationId, entryId) DO UPDATE SET boundary = 1`)
                .run(row.conversationId, row.startEntryId);
            this.db
                .prepare(`INSERT INTO sittings (conversationId, startEntryId, startAt, boundary, boundaryText, previous, block, title, titleState)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(row.conversationId, row.startEntryId, row.startAt, row.boundary ? 1 : 0, row.boundaryText, row.previous === null ? null : JSON.stringify(row.previous), row.block === null ? null : JSON.stringify(row.block), row.title, row.titleState);
            if (sealPrevious !== undefined) {
                this.db
                    .prepare(`INSERT INTO sitting_lines (conversationId, startEntryId, text, cls, coversThrough, sealed)
						 VALUES (?, ?, ?, ?, ?, 1)
						 ON CONFLICT(conversationId, startEntryId) DO UPDATE SET
						 text = excluded.text, cls = excluded.cls, coversThrough = excluded.coversThrough, sealed = 1
						 WHERE sitting_lines.sealed = 0`)
                    .run(row.conversationId, sealPrevious.startEntryId, sealPrevious.line.text, sealPrevious.line.cls, sealPrevious.line.coversThrough);
            }
            this.db.exec("COMMIT");
            return true;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    /** Sittings for the given conversations, ordered by startEntryId. */
    sittings(conversationIds) {
        if (conversationIds.length === 0)
            return [];
        const placeholders = conversationIds.map(() => "?").join(",");
        // SAFETY: placeholders are generated from array length; values are bound.
        const rows = this.db
            .prepare(`SELECT * FROM sittings WHERE conversationId IN (${placeholders}) ORDER BY startEntryId`)
            .all(...conversationIds);
        return rows.map((row) => ({
            conversationId: row.conversationId,
            startEntryId: row.startEntryId,
            startAt: row.startAt,
            boundary: row.boundary === 1,
            boundaryText: row.boundaryText,
            previous: row.previous === null ? null : JSON.parse(row.previous),
            block: row.block === null ? null : JSON.parse(row.block),
            title: row.title,
            titleState: row.titleState,
        }));
    }
    /** Insert-or-ignore: used for the first, non-boundary sitting. */
    putSitting(row) {
        this.db
            .prepare(`INSERT INTO sittings (conversationId, startEntryId, startAt, boundary, boundaryText, previous, block, title, titleState)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(conversationId, startEntryId) DO NOTHING`)
            .run(row.conversationId, row.startEntryId, row.startAt, row.boundary ? 1 : 0, row.boundaryText, row.previous === null ? null : JSON.stringify(row.previous), row.block === null ? null : JSON.stringify(row.block), row.title, row.titleState);
    }
    /** Update the title and title state of a sitting. */
    setSittingTitle(conversationId, startEntryId, title, state) {
        this.db
            .prepare(`UPDATE sittings SET title = ?, titleState = ? WHERE conversationId = ? AND startEntryId = ?`)
            .run(title, state, conversationId, startEntryId);
    }
    /** Lines for the given conversations. */
    lines(conversationIds) {
        if (conversationIds.length === 0)
            return [];
        const placeholders = conversationIds.map(() => "?").join(",");
        // SAFETY: placeholders are generated from array length; values are bound.
        const rows = this.db
            .prepare(`SELECT * FROM sitting_lines WHERE conversationId IN (${placeholders}) ORDER BY startEntryId`)
            .all(...conversationIds);
        return rows.map((row) => ({
            conversationId: row.conversationId,
            startEntryId: row.startEntryId,
            text: row.text,
            cls: row.cls,
            coversThrough: row.coversThrough,
            sealed: row.sealed === 1,
        }));
    }
    /** Write a draft line; no-op if the row is already sealed. */
    putLineDraft(row) {
        this.db
            .prepare(`INSERT INTO sitting_lines (conversationId, startEntryId, text, cls, coversThrough, sealed)
				 VALUES (?, ?, ?, ?, ?, 0)
				 ON CONFLICT(conversationId, startEntryId) DO UPDATE SET
				 	text = excluded.text, cls = excluded.cls, coversThrough = excluded.coversThrough
				 	WHERE sitting_lines.sealed = 0`)
            .run(row.conversationId, row.startEntryId, row.text, row.cls, row.coversThrough);
    }
    /** Upsert a line as sealed with exactly this content; no-op when already sealed. */
    sealLine(conversationId, startEntryId, line) {
        this.db
            .prepare(`INSERT INTO sitting_lines (conversationId, startEntryId, text, cls, coversThrough, sealed)
				 VALUES (?, ?, ?, ?, ?, 1)
				 ON CONFLICT(conversationId, startEntryId) DO UPDATE SET
				 	text = excluded.text, cls = excluded.cls, coversThrough = excluded.coversThrough, sealed = 1
				 	WHERE sitting_lines.sealed = 0`)
            .run(conversationId, startEntryId, line.text, line.cls, line.coversThrough);
    }
    /** Month lines for the given conversations. */
    monthLines(conversationIds) {
        if (conversationIds.length === 0)
            return [];
        const placeholders = conversationIds.map(() => "?").join(",");
        // SAFETY: placeholders are generated from array length; values are bound.
        const rows = this.db
            .prepare(`SELECT * FROM month_lines WHERE conversationId IN (${placeholders}) ORDER BY month`)
            .all(...conversationIds);
        return rows.map((row) => ({
            conversationId: row.conversationId,
            month: row.month,
            text: row.text,
            cls: row.cls,
        }));
    }
    /** Insert-or-ignore: written once per month. */
    putMonthLine(row) {
        this.db
            .prepare(`INSERT INTO month_lines (conversationId, month, text, cls) VALUES (?, ?, ?, ?)
				 ON CONFLICT(conversationId, month) DO NOTHING`)
            .run(row.conversationId, row.month, row.text, row.cls);
    }
    close() {
        this.db.close();
    }
}
function docFromStored(row) {
    const parsed = JSON.parse(row.sources);
    const sources = Array.isArray(parsed)
        ? parsed.filter((source) => typeof source === "string")
        : [];
    return { ...row, sources };
}
