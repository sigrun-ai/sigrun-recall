import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RunSettledEvent, SigrunHost } from "@sigrun/sigrun/extension";
import { afterEach, describe, expect, it } from "vitest";

import { RecallDb } from "../src/db.js";
import {
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
});
