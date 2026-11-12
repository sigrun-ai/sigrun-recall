import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RunSettledEvent, SigrunHost } from "@sigrun/sigrun/extension";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecallDb } from "../src/db.js";
import {
	cleanTitle,
	createSittingTitler,
	TITLE_PROMPT,
} from "../src/sittings/titles.js";
import type { SittingRow } from "../src/sittings/types.js";

const T0 = Date.UTC(2026, 0, 5, 12);
const CONVERSATION = 1 as ConversationId;

const openDatabases: RecallDb[] = [];

afterEach(() => {
	for (const db of openDatabases.splice(0)) db.close();
});

function memoryDb(): RecallDb {
	const db = RecallDb.open(":memory:");
	openDatabases.push(db);
	return db;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "acme-local",
		model: "chat-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: T0 + 1_000,
	};
}

function answered(overrides: Partial<RunSettledEvent> = {}): RunSettledEvent {
	return {
		conversationId: CONVERSATION,
		owner: "alice",
		inputs: [],
		inputTexts: [],
		outcome: {
			status: "answered",
			answerEntryId: 20 as EntryId,
			answer: assistant("Plant tomatoes in spring."),
		},
		...overrides,
	};
}

function sitting(overrides: Partial<SittingRow> = {}): SittingRow {
	return {
		conversationId: 1,
		startEntryId: 10,
		startAt: T0,
		boundary: true,
		boundaryText: "Plan the vegetable garden this spring",
		previous: null,
		block: null,
		title: null,
		titleState: "pending",
		...overrides,
	};
}

interface FakeHost {
	host: Pick<SigrunHost, "conversations" | "models">;
	calls: {
		role?: "utility";
		systemPrompt?: string;
		prompt: string;
		timeoutMs?: number;
	}[];
	names: { id: ConversationId; title: string }[];
	marks: { id: ConversationId; at: EntryId; label: string }[];
}

function fakeHost(options: {
	completion?: string | Error;
	applied?: boolean;
	newHostCalls?: boolean;
} = {}): FakeHost {
	const calls: FakeHost["calls"] = [];
	const names: FakeHost["names"] = [];
	const marks: FakeHost["marks"] = [];
	const newHostCalls = options.newHostCalls ?? true;
	const conversations = {
		...(newHostCalls
			? {
					setAutoName: async (id: ConversationId, title: string) => {
						names.push({ id, title });
						return { applied: options.applied ?? true };
					},
					markContext: async (
						id: ConversationId,
						mark: { at: EntryId; label: string },
					) => {
						marks.push({ id, ...mark });
						return { entryId: 21 as EntryId };
					},
				}
			: {}),
	};
	return {
		host: {
			conversations,
			models: {
				complete: async (input: FakeHost["calls"][number]) => {
					calls.push(input);
					if (options.completion instanceof Error) throw options.completion;
					return {
						text: options.completion ?? "Planting the spring vegetable garden today",
						model: "acme-local/chat-1",
					};
				},
			},
		} as unknown as FakeHost["host"],
		calls,
		names,
		marks,
	};
}

function rig(fake: FakeHost, db = memoryDb()) {
	db.putSitting(sitting());
	const logs: string[] = [];
	const titler = createSittingTitler({
		db: () => db,
		host: fake.host,
		log: (message: string) => logs.push(message),
	});
	return { db, titler, logs };
}

describe("sitting titler", () => {
	it("titles the sitting and marks the divider", async () => {
		const fake = fakeHost({ completion: "Title: Planting the spring vegetable garden today." });
		const { db, titler, logs } = rig(fake);
		db.putSitting(sitting({ startEntryId: 1, titleState: "none" }));
		db.putSitting(sitting({ startEntryId: 20 }));

		titler.onSettled(answered());
		await titler.idle();

		expect(fake.calls).toEqual([{
			role: "utility",
			systemPrompt: TITLE_PROMPT,
			prompt: "User: Plan the vegetable garden this spring\n\nAssistant: Plant tomatoes in spring.",
			timeoutMs: 20_000,
		}]);
		expect(fake.names).toEqual([{
			id: CONVERSATION,
			title: "Planting the spring vegetable garden today",
		}]);
		expect(fake.marks).toEqual([{
			id: CONVERSATION,
			at: 10 as EntryId,
			label: "New sitting · Planting the spring vegetable garden today",
		}]);
		expect(db.sittings([1]).find((row) => row.startEntryId === 10)).toMatchObject({
			title: "Planting the spring vegetable garden today",
			titleState: "done",
		});
		expect(db.sittings([1]).find((row) => row.startEntryId === 1)?.titleState).toBe("none");
		expect(db.sittings([1]).find((row) => row.startEntryId === 20)?.titleState).toBe("pending");
		expect(logs).toEqual([]);
	});

	it("a typed name is left alone", async () => {
		const fake = fakeHost({ applied: false });
		const { db, titler } = rig(fake);

		titler.onSettled(answered());
		await titler.idle();

		expect(fake.names).toHaveLength(1);
		expect(fake.marks.map((mark) => mark.label)).toEqual([
			"New sitting · Planting the spring vegetable garden today",
		]);
		expect(db.sittings([1])[0]?.titleState).toBe("done");
	});

	it("a failure marks New sitting", async () => {
		const fake = fakeHost({ completion: new Error("utility model unavailable") });
		const { db, titler, logs } = rig(fake);

		titler.onSettled(answered());
		await titler.idle();

		expect(fake.names).toEqual([]);
		expect(fake.marks).toEqual([{
			id: CONVERSATION,
			at: 10 as EntryId,
			label: "New sitting",
		}]);
		expect(db.sittings([1])[0]).toMatchObject({ title: null, titleState: "failed" });
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("utility model unavailable");
	});

	it("a settle without an outcome is ignored without a background rejection", async () => {
		const fake = fakeHost();
		const { db, titler, logs } = rig(fake);

		titler.onSettled({ conversationId: CONVERSATION } as RunSettledEvent);
		await titler.idle();

		expect(fake.calls).toEqual([]);
		expect(fake.marks).toEqual([]);
		expect(db.sittings([1])[0]?.titleState).toBe("pending");
		expect(logs).toEqual([]);
	});

	it("a replayed settle does nothing", async () => {
		const fake = fakeHost();
		const { db, titler, logs } = rig(fake);

		titler.onSettled(answered({ replayed: true }));
		await titler.idle();

		expect(fake.calls).toEqual([]);
		expect(fake.names).toEqual([]);
		expect(fake.marks).toEqual([]);
		expect(db.sittings([1])[0]).toMatchObject({ title: null, titleState: "pending" });
		expect(logs).toEqual([]);
	});

	it("a core without the host calls is a no-op, not an error", async () => {
		const fake = fakeHost({ newHostCalls: false });
		const { db, titler, logs } = rig(fake);

		titler.onSettled(answered());
		await titler.idle();

		expect(fake.calls).toHaveLength(1);
		expect(db.sittings([1])[0]).toMatchObject({
			title: "Planting the spring vegetable garden today",
			titleState: "done",
		});
		expect(logs).toEqual([]);
	});

	it("a local-only sitting never calls the model", async () => {
		const fake = fakeHost();
		const db = memoryDb();
		db.setTaint(1, 10);
		const { titler, logs } = rig(fake, db);
		db.putSitting(sitting({
			startEntryId: 30,
			boundaryText: "Private plans for the garden tomorrow",
		}));

		titler.onSettled(answered());
		await titler.idle();

		expect(fake.calls).toEqual([]);
		expect(db.sittings([1]).find((row) => row.startEntryId === 10)).toMatchObject({
			title: "Plan the vegetable garden this spring",
			titleState: "done",
		});
		expect(db.sittings([1]).find((row) => row.startEntryId === 30)?.titleState).toBe("pending");
		expect(fake.marks).toEqual([{
			id: CONVERSATION,
			at: 10 as EntryId,
			label: "New sitting · Plan the vegetable garden this spring",
		}]);
		expect(logs).toEqual([]);
	});

	it("taint after the sitting starts keeps its answer away from the model", async () => {
		const fake = fakeHost();
		const db = memoryDb();
		db.setTaint(1, 15);
		const { titler, logs } = rig(fake, db);

		titler.onSettled(answered());
		await titler.idle();

		expect(fake.calls).toEqual([]);
		expect(fake.names).toEqual([{
			id: CONVERSATION,
			title: "Plan the vegetable garden this spring",
		}]);
		expect(fake.marks).toEqual([{
			id: CONVERSATION,
			at: 10 as EntryId,
			label: "New sitting · Plan the vegetable garden this spring",
		}]);
		expect(db.sittings([1])[0]).toMatchObject({
			title: "Plan the vegetable garden this spring",
			titleState: "done",
		});
		expect(logs).toEqual([]);
	});

	it("two pending sittings complete sequentially and the newest title wins", async () => {
		const fake = fakeHost();
		const db = memoryDb();
		const logs: string[] = [];
		let releaseFirst!: (value: { text: string; model: string }) => void;
		const first = new Promise<{ text: string; model: string }>((resolve) => {
			releaseFirst = resolve;
		});
		fake.host.models.complete = async () => {
			fake.calls.push({ prompt: "title" });
			if (fake.calls.length === 1) return first;
			return { text: "Newest sitting title", model: "acme-local/chat-1" };
		};
		db.putSitting(sitting());
		db.putSitting(sitting({ startEntryId: 15, boundaryText: "Newest question" }));
		const titler = createSittingTitler({
			db: () => db,
			host: fake.host,
			log: (message: string) => logs.push(message),
		});

		titler.onSettled(answered());
		await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fake.calls).toHaveLength(1);
		expect(fake.names).toEqual([]);
		releaseFirst({ text: "First sitting title", model: "acme-local/chat-1" });
		await titler.idle();

		expect(fake.calls).toHaveLength(2);
		expect(fake.names.map((name) => name.title)).toEqual([
			"First sitting title",
			"Newest sitting title",
		]);
		expect(fake.marks.map((mark) => mark.label)).toEqual([
			"New sitting · First sitting title",
			"New sitting · Newest sitting title",
		]);
		expect(fake.marks.map((mark) => Number(mark.at))).toEqual([10, 15]);
		expect(logs).toEqual([]);
	});

	it("a shutdown abandons title work instead of reopening the database", async () => {
		const fake = fakeHost();
		const db = memoryDb();
		db.putSitting(sitting());
		let closed = false;
		const logs: string[] = [];
		const titler = createSittingTitler({
			db: () => {
				if (closed) throw new Error("database reopened");
				return db;
			},
			host: fake.host,
			log: (message: string) => logs.push(message),
		});
		let release!: (value: { text: string; model: string }) => void;
		fake.host.models.complete = () => new Promise((resolve) => { release = resolve; });

		titler.onSettled(answered());
		await Promise.resolve();
		const shutdown = titler.shutdown();
		closed = true;
		release({ text: "Late title", model: "acme-local/chat-1" });
		await shutdown;
		await titler.idle();

		expect(fake.names).toEqual([]);
		expect(fake.marks).toEqual([]);
		expect(db.sittings([1])[0]?.titleState).toBe("pending");
		expect(logs).toEqual([]);
	});

	it("a database failure logs once and does not poison later settles", async () => {
		const fake = fakeHost();
		const db = memoryDb();
		const logs: string[] = [];
		let fail = true;
		const titler = createSittingTitler({
			db: () => {
				if (fail) throw new Error("database unavailable");
				return db;
			},
			host: fake.host,
			log: (message: string) => logs.push(message),
		});
		db.putSitting(sitting());

		titler.onSettled(answered());
		await titler.idle();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("database unavailable");

		fail = false;
		titler.onSettled(answered());
		await titler.idle();
		expect(fake.calls).toHaveLength(1);
		expect(db.sittings([1])[0]?.titleState).toBe("done");
		expect(logs).toHaveLength(1);
	});

	it.each([
		["`Quoted title`", "Quoted title"],
		["Title: Garden plans", "Garden plans"],
		["Garden plans!", "Garden plans"],
		["one two three four five six seven", "one two three four five six"],
		[
			`first ${"x".repeat(60)}`,
			"first",
		],
		["x".repeat(61), "x".repeat(60)],
		["Garden\u0000 plans\u001f", "Garden plans"],
		["Garden\nplans", "Garden plans"],
		["Garden\u0080 plans\u009f", "Garden plans"],
		["   \n\t  ", undefined],
	])("cleans %j without drifting from core", (raw, expected) => {
		expect(cleanTitle(raw)).toBe(expected);
	});
});
