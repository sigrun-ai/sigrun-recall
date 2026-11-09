import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { EmbeddingResult } from "@sigrun/shared/embeddings";
import { describe, expect, it, vi } from "vitest";

import { RecallDb } from "../src/db.js";
import createRecall from "../src/index.js";

const NOW = 1_700_000_000_000;
const LABEL = "openai/text-embedding-3-small";
const OLD = "acme-embed/embed-1";
const NEW = "acme-embed/embed-2";

type EmbedOptions = {
	model?: string;
	confidentiality?: "normal" | "local-only";
	timeoutMs?: number;
};

interface EmbedCall {
	texts: readonly string[];
	opts: EmbedOptions | undefined;
}

interface EmbeddingRow {
	model: string;
	provider: string;
	dimensions: number;
	local: boolean;
	default: boolean;
	status: "ready" | "degraded" | "not_configured";
}

function row(
	model: string,
	options: { local?: boolean; isDefault?: boolean; dimensions?: number } = {},
): EmbeddingRow {
	return {
		model,
		provider: model.slice(0, model.indexOf("/")),
		dimensions: options.dimensions ?? 2,
		local: options.local ?? false,
		default: options.isDefault ?? false,
		status: "ready",
	};
}

const NO_MODEL: EmbeddingResult = {
	ok: false,
	code: "no_model",
	message: "no embedding model is configured",
};

/** A fake `host.embeddings` that records every call. */
function embeddings(
	options: {
		rows?: readonly EmbeddingRow[];
		list?: () => Promise<readonly EmbeddingRow[]>;
		embed?: (texts: readonly string[], opts: EmbedOptions | undefined) => EmbeddingResult;
	} = {},
) {
	const calls: EmbedCall[] = [];
	let listCalls = 0;
	const surface = {
		async list() {
			listCalls += 1;
			return options.list === undefined ? (options.rows ?? []) : options.list();
		},
		async embed(texts: readonly string[], opts?: EmbedOptions) {
			calls.push({ texts, opts });
			return options.embed === undefined ? NO_MODEL : options.embed(texts, opts);
		},
	};
	return { calls, surface, listCalls: () => listCalls };
}

function messageEntry(
	id: number,
	conversationId: number,
	text: string,
	timestamp = NOW,
	role: "user" | "assistant" = "user",
): EntryRecord {
	return {
		id,
		conversationId,
		kind: "pi.message",
		model: [{ role, content: [{ type: "text", text }], timestamp }],
	} as unknown as EntryRecord;
}

const META = {
	pinned: false,
	tagged: [],
	archived: false,
	draft: { text: "", attachments: [] },
	source: "test",
	owner: "alice",
	name: "Past work",
};

interface HostOptions {
	root: string;
	settings?: Record<string, unknown>;
	embeddings: ReturnType<typeof embeddings>["surface"];
	entries?: readonly EntryRecord[];
	users?: readonly { user: string; admin: boolean }[];
	notify?: (input: unknown) => Promise<void>;
}

function fakeHost(options: HostOptions) {
	const entries = options.entries ?? [];
	return {
		stores: {
			paths: { data: options.root },
			settings: { get: async () => options.settings ?? {} },
			secrets: { get: async () => undefined },
		},
		conversations: {
			meta: async () => META,
			entry: async () => entries[0],
			entries: async () => ({ items: entries }),
			list: async () => [{ id: 1 }],
		},
		embeddings: options.embeddings,
		users: { list: async () => options.users ?? [] },
		notify: options.notify ?? (async () => undefined),
	} as never;
}

interface Rig {
	result: Awaited<ReturnType<typeof createRecall>>;
	db: () => RecallDb | undefined;
	search: (query: string) => Promise<{ hits: { conversationId: number | null }[] }>;
	backfill: () => Promise<unknown>;
}

async function rig(
	options: Omit<HostOptions, "root"> & { root: string },
): Promise<Rig> {
	let opened: RecallDb | undefined;
	const result = await createRecall(fakeHost(options), {
		openDb: (path, labelModel) => {
			opened = RecallDb.open(path, labelModel);
			return opened;
		},
	});
	const route = (path: string) => result.routes!.find((entry) => entry.path === path)!;
	return {
		result,
		db: () => opened,
		search: async (query) => {
			const response = await route("search").handler(
				new Request(`https://example.invalid/search?q=${encodeURIComponent(query)}`),
				{ principal: { user: "alice", admin: false } } as never,
			);
			return (await response.json()) as { hits: { conversationId: number | null }[] };
		},
		backfill: async () => {
			const response = await route("backfill").handler(
				new Request("https://example.invalid/backfill", { method: "POST" }),
				{ principal: { user: "alice", admin: true } } as never,
			);
			return response.json();
		},
	};
}

/** Set the conversation's taint point in its database. */
async function seedTaint(root: string, entryId: number): Promise<void> {
	const db = RecallDb.open(join(root, "recall.db"));
	try {
		db.setTaint(1, entryId);
	} finally {
		db.close();
	}
}

/** Seed one searchable item and an optional vector for it, then close. */
async function seed(
	root: string,
	options: {
		text: string;
		cls?: "normal" | "local-only";
		vector?: { model: string; vec: number[] };
		taintFrom?: number;
	},
): Promise<void> {
	const db = RecallDb.open(join(root, "recall.db"));
	try {
		const id = db.insertItem(
			{
				conversationId: 1,
				owner: "alice",
				kind: "turn",
				entryId: 1,
				messageIndex: 0,
				blockIndex: 0,
				offset: 0,
				length: options.text.length,
				artifact: null,
				doc: null,
				job: false,
				cls: options.cls ?? "normal",
				at: NOW,
				title: "Past work",
			},
			options.text,
		);
		if (id === undefined) throw new Error("seed: the item was not inserted");
		if (options.vector !== undefined) {
			db.upsertVector(id, options.vector.model, new Float32Array(options.vector.vec));
		}
		if (options.taintFrom !== undefined) db.setTaint(1, options.taintFrom);
	} finally {
		db.close();
	}
}

describe("host.embeddings in recall", () => {
	it("no re-embed when the default matches the label", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-label-match-"));
		try {
			await seed(root, {
				text: "canine knee operation",
				vector: { model: LABEL, vec: [1, 0] },
			});
			const { surface, calls } = embeddings({
				rows: [row(LABEL, { isDefault: true })],
				embed: (texts, opts) => ({
					ok: true,
					model: opts?.model ?? LABEL,
					dimensions: 2,
					vectors: texts.map(() => new Float32Array([1, 0])),
				}),
			});
			const { result, db, backfill, search } = await rig({
				root,
				settings: {
					embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
				},
				embeddings: surface,
				entries: [messageEntry(1, 1, "canine knee operation")],
			});
			// The sweep found nothing pending: the inherited, correctly
			// labelled rows are reused instead of re-embedded.
			await backfill();
			expect(calls).toEqual([]);
			expect(db()!.listVectorsPage(LABEL, 0, 10)).toHaveLength(1);
			// And the query path embeds with THAT model, so the inherited
			// vectors are actually reachable.
			const hits = await search("canine knee operation");
			expect(hits.hits).toHaveLength(1);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.opts?.model).toBe(LABEL);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("local-only items stay lexical on not_local", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-not-local-"));
		try {
			await seedTaint(root, 1);
			const { surface, calls } = embeddings({
				rows: [row(NEW, { isDefault: true, local: false })],
				embed: () => ({
					ok: false,
					code: "not_local",
					message: "the model is not local",
				}),
			});
			const { result, db } = await rig({
				root,
				embeddings: surface,
				entries: [messageEntry(1, 1, "harbourside bakery bread")],
			});
			// The tainted conversation's capture page submits local-only text.
			await result.runSettled?.(
				{ conversationId: 1 } as never,
				{ entries: async () => ({ items: [messageEntry(1, 1, "harbourside bakery bread")] }) } as never,
				{} as never,
			);
			await vi.waitFor(() => expect(calls).toHaveLength(1));
			expect(calls[0]?.opts?.confidentiality).toBe("local-only");
			// Core refused it for a model it does not trust with local material:
			// no vector, but the item is still there to be searched lexically.
			expect(db()!.listVectorsPage(NEW, 0, 10)).toEqual([]);
			// No vector, but the item is still in the lexical index: a reader the
			// local-only rule allows finds it there. (The debug search route has
			// no model, so `mayRead` fails closed on local-only; the audience
			// gate is not what this test is about.)
			expect(db()!.matchTrigram('"bakery"')).toHaveLength(1);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("no embedding model means lexical search", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-no-model-"));
		try {
			await seed(root, { text: "clinic appointment notes" });
			const { surface, calls, listCalls } = embeddings({ rows: [] });
			const { result, search } = await rig({
				root,
				embeddings: surface,
				entries: [messageEntry(1, 1, "clinic appointment notes")],
			});
			const body = await search("clinic");
			expect(body.hits).toHaveLength(1);
			// Recall ASKED which models exist and found none, so it never tried
			// to embed — lexical search is the documented fallback.
			expect(listCalls()).toBeGreaterThan(0);
			expect(calls).toEqual([]);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("capture embeds normal and local-only items in separate calls", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-two-batches-"));
		try {
			// Taint from entry 2: entry 1 is normal, entry 2 is local-only, so
			// ONE capture page carries both classes.
			await seedTaint(root, 2);
			const { surface, calls } = embeddings({
				rows: [row(NEW, { isDefault: true, local: true })],
				embed: (texts, opts) => ({
					ok: true,
					model: NEW,
					dimensions: 2,
					vectors: texts.map(
						() =>
							new Float32Array(
								opts?.confidentiality === "local-only" ? [0, 1] : [1, 0],
							),
					),
				}),
			});
			const { result } = await rig({ root, embeddings: surface });
			await result.runSettled?.(
				{ conversationId: 1 } as never,
				{
					entries: async () => ({
						items: [
							messageEntry(1, 1, "a public question"),
							messageEntry(2, 1, "a private answer"),
						],
					}),
				} as never,
				{} as never,
			);
			await vi.waitFor(() => expect(calls).toHaveLength(2));
			expect(calls.map((call) => call.opts?.confidentiality)).toEqual([
				"normal",
				"local-only",
			]);
			expect(calls[0]?.texts).toEqual(["a public question"]);
			expect(calls[1]?.texts).toEqual(["a private answer"]);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	/**
	 * One switch scenario, parameterised by where the two models sit in
	 * `list()` order. Core enumerates a provider's models in DECLARATION
	 * order, so the same-provider switch (the common one) can list the old
	 * model first OR the new one first — the rule must not depend on it.
	 */
	async function switchScenario(ordering: "old-first" | "new-first"): Promise<void> {
		const root = await mkdtemp(join(tmpdir(), `recall-switch-${ordering}-`));
		try {
			// The old model covered the only item: its vectors are complete.
			await seed(root, {
				text: "canine knee operation",
				vector: { model: OLD, vec: [1, 0] },
			});
			const rows =
				ordering === "old-first"
					? [row(OLD), row(NEW, { isDefault: true })]
					: [row(NEW, { isDefault: true }), row(OLD)];
			const { surface, calls } = embeddings({
				rows,
				embed: (texts, opts) => ({
					ok: true,
					model: opts?.model ?? NEW,
					dimensions: 2,
					vectors: texts.map(() =>
						(opts?.model ?? NEW) === OLD
							? new Float32Array([1, 0])
							: new Float32Array([0, 1]),
					),
				}),
			});
			const { result, db, search, backfill } = await rig({
				root,
				embeddings: surface,
				entries: [messageEntry(1, 1, "canine knee operation")],
			});
			// Before the sweep covers the new model, queries use the OLD index
			// (complete) — never the current model's empty one.
			const early = await search("dog surgery");
			expect(early.hits).toHaveLength(1);
			expect(calls.at(-1)?.opts?.model).toBe(OLD);
			expect(db()!.listVectorsPage(OLD, 0, 10)).toHaveLength(1);
			// The sweep re-embeds into the current model, then drops the old rows.
			await backfill();
			expect(calls.some((call) => call.opts?.model === NEW)).toBe(true);
			expect(db()!.listVectorsPage(NEW, 0, 10)).toHaveLength(1);
			expect(db()!.listVectorsPage(OLD, 0, 10)).toEqual([]);
			// Queries now embed with the new model, against its own vectors. The
			// old rows are gone, so a query still embedding with OLD would find
			// nothing at all.
			const late = await search("dog surgery");
			expect(late.hits).toHaveLength(1);
			expect(calls.at(-1)?.opts?.model).toBe(NEW);
			expect(calls.at(-1)?.opts?.timeoutMs).toBe(800);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	it("a model switch re-embeds in the background and keeps searching the old index until coverage", async () => {
		// Both list() orderings: a complete model registered BEFORE the
		// current default must still answer (the [OI] same-provider switch
		// lists small-then-large with large default LAST), and the mirrored
		// ordering must behave identically.
		await switchScenario("old-first");
		await switchScenario("new-first");
	});

	it("a throwing embedding host during capture is contained, never an unhandled rejection", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-capture-throw-"));
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		const warnings: unknown[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args);
		try {
			const { surface } = embeddings({
				rows: [row(NEW, { isDefault: true })],
				// The contract says `embed` never throws; a host that breaks it
				// (an unbound bridge, a closed database after shutdown) must not
				// take the process down from a fire-and-forget capture.
				embed: () => {
					throw new Error("bridge unavailable");
				},
			});
			const { result } = await rig({
				root,
				embeddings: surface,
				entries: [messageEntry(1, 1, "a passage to embed")],
			});
			await result.runSettled?.(
				{ conversationId: 1 } as never,
				{ entries: async () => ({ items: [messageEntry(1, 1, "a passage to embed")] }) } as never,
				{} as never,
			);
			// Let the rejected capture work settle and Node's own detection run.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(rejections).toEqual([]);
			expect(warnings.some((entry) => String(entry).includes("embedding"))).toBe(true);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			console.warn = originalWarn;
			process.off("unhandledRejection", onRejection);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("the notice goes to the primary admin on a claimed server", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-notice-admin-"));
		try {
			const notified: { user?: string; kind?: string; title?: string; body?: string }[] = [];
			const { surface } = embeddings({ rows: [] });
			const { result } = await rig({
				root,
				settings: {
					embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
				},
				embeddings: surface,
				users: [
					{ user: "bob", admin: false },
					{ user: "alice", admin: true },
					{ user: "carol", admin: true },
				],
				notify: async (input) => {
					notified.push(input as never);
				},
			});
			await vi.waitFor(() => expect(notified).toHaveLength(1));
			expect(notified[0]?.user).toBe("alice");
			expect(notified[0]?.kind).toBe("recall.embeddings-moved");
			expect(notified[0]?.title).toBe("Recall embeddings now come from a provider");
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("the notice goes out userless on an empty (single-operator) server", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-notice-userless-"));
		try {
			const notified: { user?: string; kind?: string }[] = [];
			const { surface } = embeddings({ rows: [] });
			const { result } = await rig({
				root,
				settings: {
					embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
				},
				embeddings: surface,
				// An unclaimed server: nobody to name, but core still delivers
				// the notice (notifyExtension demands a user only on a CLAIMED
				// directory).
				users: [],
				notify: async (input) => {
					notified.push(input as never);
				},
			});
			await vi.waitFor(() => expect(notified).toHaveLength(1));
			expect(notified[0]?.user).toBeUndefined();
			expect(notified[0]?.kind).toBe("recall.embeddings-moved");
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("a claimed server with no admin is the one case the notice is dropped for", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-notice-no-admin-"));
		try {
			const notified: unknown[] = [];
			const { surface } = embeddings({ rows: [] });
			const { result, search } = await rig({
				root,
				settings: {
					embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
				},
				embeddings: surface,
				// Users exist, so core would REJECT a userless notice; nobody
				// carries the admin flag, so there is no valid recipient.
				users: [
					{ user: "bob", admin: false },
					{ user: "carol", admin: false },
				],
				notify: async (input) => {
					notified.push(input);
				},
			});
			await search("clinic");
			await search("clinic");
			expect(notified).toEqual([]);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("the notice is dropped on a claimed server with no admin", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-notice-no-admin-"));
		try {
			const notified: unknown[] = [];
			const { surface } = embeddings({ rows: [] });
			const { result, search } = await rig({
				root,
				settings: {
					embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
				},
				embeddings: surface,
				// Users exist, so core would REJECT a userless notice; nobody is
				// an admin, so there is no recipient this notice is for.
				users: [
					{ user: "bob", admin: false },
					{ user: "carol", admin: false },
				],
				notify: async (input) => {
					notified.push(input);
				},
			});
			await search("clinic");
			await search("clinic");
			expect(notified).toEqual([]);
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("the moved-settings notice fires once and names the outcome", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-notice-once-"));
		try {
			const notified: { user?: string; body?: string }[] = [];
			const { surface } = embeddings({ rows: [row(NEW, { isDefault: true })] });
			const { result, search } = await rig({
				root,
				settings: {
					embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
				},
				embeddings: surface,
				users: [{ user: "alice", admin: true }],
				notify: async (input) => {
					notified.push(input as never);
				},
			});
			await search("clinic");
			await search("clinic");
			expect(notified).toHaveLength(1);
			const body = notified[0]?.body ?? "";
			expect(body).toContain("text-embedding-3-small");
			expect(body).toContain(`kept`);
			expect(body).toContain(LABEL);
			expect(body).toContain("embeddingModel");
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("the moved-settings notice says unlabelled vectors are re-embedded", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-notice-reembed-"));
		try {
			const notified: { body?: string }[] = [];
			const { surface } = embeddings({ rows: [row(NEW, { isDefault: true })] });
			const { result } = await rig({
				root,
				settings: {
					embedding: { url: "https://example.invalid/v1", model: "embed-model" },
				},
				embeddings: surface,
				users: [{ user: "alice", admin: true }],
				notify: async (input) => {
					notified.push(input as never);
				},
			});
			await vi.waitFor(() => expect(notified).toHaveLength(1));
			const body = notified[0]?.body ?? "";
			expect(body).toContain("embed-model");
			expect(body).toContain("re-embedded");
			expect(body).toContain("embeddingModel");
			await result.harnessShutdown?.({} as never, {} as never);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
