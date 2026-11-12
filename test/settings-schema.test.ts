/**
 * Recall's declared settings (settings rework, Task 2): the shared
 * `externalizeBytes` key and the per-user `autoRecall` setting, as JSON
 * Schema. These tests pin the contract the deleted
 * `resolveSettings`/`resolveUserSettings` parsers implemented by hand —
 * every default, and what a malformed stored value becomes — plus the two
 * facts the schema itself decides: per-user settings stay per user, and
 * there is no `embedding` group to configure (embeddings come from
 * `host.embeddings`).
 */

import { describe, expect, test, vi } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";

import createRecall from "../src/index.js";
import {
	RECALL_SETTINGS_SCHEMA,
	RECALL_USER_SETTINGS_SCHEMA,
	type UserRecallSettings,
} from "../src/settings-schema.js";
import { createSettingsStub, type SettingsStub } from "./fake-host.js";

/** The defaults the deleted parsers filled in, verbatim. */
const DEFAULT_SHARED = { externalizeBytes: 24_576, sittings: { minGapMinutes: 60, minHistoryTokens: 8000 } };
const DEFAULT_USER: UserRecallSettings = { autoRecall: true, sittings: true };

/**
 * Run the factory over a settings stub, hand the stub to `body`, then shut
 * the extension down and remove the stub's root.
 */
async function withRecall(
	options: Parameters<typeof createSettingsStub>[0],
	body: (
		stub: SettingsStub,
		result: Awaited<ReturnType<typeof createRecall>>,
	) => Promise<void>,
): Promise<void> {
	const stub = await createSettingsStub(options);
	try {
		const result = await createRecall({
			stores: {
				paths: { data: stub.dataDir },
				settings: { get: stub.rawSettings },
				user: (user: string) => ({
					settings: {
						get: async () => JSON.parse(await stub.raw(stub.userPath(user)) ?? "{}"),
						set: async (value: Record<string, unknown>) => stub.saveUser(user, value),
					},
				}),
			},
			conversations: {
				meta: async () => ({ owner: "alice", internal: false }),
			},
			models: { isLocal: () => false },
			// The migration walk sees the fixture users; ordinary fixtures have
			// no localProviders list and therefore produce no notice.
			users: {
				list: async () =>
					Object.keys(options?.users ?? {}).map((user) => ({ user, admin: false })),
			},
			notify: async () => undefined,
			...stub.host,
		} as never);
		await body(stub, result);
		await result.harnessShutdown?.({} as never, {} as never);
	} finally {
		await stub.close();
	}
}

/** Call the extension's afterTool hook and return its replacement text. */
function afterToolOf(result: Awaited<ReturnType<typeof createRecall>>) {
	const registration = (result.extension?.hooks ?? []).find(
		(entry) => "afterTool" in entry.handlers,
	);
	const afterTool = (registration!.handlers as {
		afterTool: (
			call: unknown,
			result: unknown,
			api: { conversationId: number },
		) => Promise<{ output?: { type: string; text: string }[] } | undefined>;
	}).afterTool;
	return async (input: { call: unknown; result: unknown }) => {
		const replaced = await afterTool(input.call, input.result, { conversationId: 1 });
		const text = replaced?.output?.find((part) => part.type === "text")?.text;
		return text ?? "";
	};
}

describe("recall settings schema", () => {
	test("schema is drawable", () => {
		assertDrawable(RECALL_SETTINGS_SCHEMA);
		assertDrawable(RECALL_USER_SETTINGS_SCHEMA);
	});

	test("the user schema no longer has localProviders", () => {
		expect(Object.keys(RECALL_USER_SETTINGS_SCHEMA.properties ?? {})).toEqual([
			"autoRecall",
			"sittings",
		]);
		// Stored copies survive as unknown keys until the factory removes them.
		expect(
			checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, {
				autoRecall: false,
				localProviders: ["acme-local"],
			}).value,
		).toEqual({ autoRecall: false, sittings: true, localProviders: ["acme-local"] });
	});

	test("defaults match the old parser", async () => {
		expect(checkStoredSettings(RECALL_SETTINGS_SCHEMA, {}).value).toEqual(DEFAULT_SHARED);
		expect(checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, {}).value).toEqual(DEFAULT_USER);
		await withRecall({}, async (stub) => {
			expect(stub.declaration).toEqual({
				schema: RECALL_SETTINGS_SCHEMA,
				userSchema: RECALL_USER_SETTINGS_SCHEMA,
			});
			expect(await stub.read()).toEqual(DEFAULT_SHARED);
			expect(await stub.readUser("alice")).toEqual(DEFAULT_USER);
		});
	});

	test("an old settings file still loads", async () => {
		await withRecall(
			{
				settings: { externalizeBytes: 50 },
				users: {
					alice: { autoRecall: false },
					bob: {},
				},
			},
			async (stub, result) => {
				expect(await stub.read()).toEqual({ externalizeBytes: 50, sittings: { minGapMinutes: 60, minHistoryTokens: 8000 } });
				expect(await stub.readUser("alice")).toEqual({ autoRecall: false, sittings: true });
				expect(await stub.readUser("bob")).toEqual(DEFAULT_USER);

				const replaced = await afterToolOf(result)({
					call: { type: "toolCall", id: "call-1", name: "web_fetch", arguments: {} },
					result: { output: [{ type: "text", text: "y".repeat(200) }] },
				});
				expect(replaced).toMatch(/a:[0-9a-f]{16}/);
			},
		);
	});

	test("a malformed value falls back to its default (the old leniency)", () => {
		for (const externalizeBytes of ["big", 0, -1, 1.5, null, [], {}]) {
			expect(
				checkStoredSettings(RECALL_SETTINGS_SCHEMA, { externalizeBytes }).value,
			).toEqual(DEFAULT_SHARED);
		}
		expect(
			checkStoredSettings(RECALL_SETTINGS_SCHEMA, { externalizeBytes: 1 }).value,
		).toEqual({ externalizeBytes: 1, sittings: { minGapMinutes: 60, minHistoryTokens: 8000 } });

		for (const autoRecall of ["yes", 1, 0, null, []]) {
			expect(
				checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, { autoRecall }).value,
			).toEqual(DEFAULT_USER);
		}
		expect(
			checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, { autoRecall: false }).value,
		).toEqual({ autoRecall: false, sittings: true });
	});

	test("sittings shared settings repair", () => {
		// minGapMinutes: 0 repairs to the default 60 (below minimum).
		expect(
			checkStoredSettings(RECALL_SETTINGS_SCHEMA, { sittings: { minGapMinutes: 0 } }).value,
		).toEqual({ externalizeBytes: 24_576, sittings: { minGapMinutes: 60, minHistoryTokens: 8000 } });
		// Valid values survive.
		expect(
			checkStoredSettings(RECALL_SETTINGS_SCHEMA, { sittings: { minGapMinutes: 30, minHistoryTokens: 4000 } }).value,
		).toEqual({ externalizeBytes: 24_576, sittings: { minGapMinutes: 30, minHistoryTokens: 4000 } });
	});

	test("sittings per-user repair", () => {
		for (const sittings of ["yes", 1, 0, null, []]) {
			expect(
				checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, { sittings }).value,
			).toEqual(DEFAULT_USER);
		}
		expect(
			checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, { sittings: false }).value,
		).toEqual({ autoRecall: true, sittings: false });
	});

	test("user settings stay per user", async () => {
		await withRecall(
			{
				users: {
					alice: { autoRecall: false },
					bob: { autoRecall: true },
				},
			},
			async (stub) => {
				const bobBefore = await stub.raw(stub.userPath("bob"));
				await stub.saveUser("alice", { autoRecall: true });
				expect(await stub.readUser("alice")).toEqual({ autoRecall: true, sittings: true });
				expect(await stub.readUser("bob")).toEqual({ autoRecall: true, sittings: true });
				expect(await stub.raw(stub.userPath("bob"))).toBe(bobBefore);
			},
		);
	});

	test("absent embedding group means no embeddings", async () => {
		expect(Object.keys(RECALL_SETTINGS_SCHEMA.properties ?? {})).toEqual([
			"externalizeBytes",
			"sittings",
		]);
		expect(Object.keys(RECALL_USER_SETTINGS_SCHEMA.properties ?? {})).toEqual([
			"autoRecall",
			"sittings",
		]);

		const embedding = {
			url: "https://api.openai.com/v1",
			model: "text-embedding-3-small",
			local: false,
			timeoutMs: 800,
		};
		await withRecall({ settings: { externalizeBytes: 512, embedding } }, async (stub) => {
			expect(await stub.read()).toEqual({ externalizeBytes: 512, sittings: { minGapMinutes: 60, minHistoryTokens: 8000 }, embedding });
			expect(await stub.rawSettings()).toEqual({ externalizeBytes: 512, embedding });
		});
	});

	test("the factory declares both schemas and reads none in its body", async () => {
		await withRecall({ settings: { externalizeBytes: 1024 } }, async (stub) => {
			expect(stub.declaration).toBeDefined();
			expect(stub.reads).toBe(0);
		});
	});
	test("a user with a stored list is told once", async () => {
		const stub = await createSettingsStub({
			users: {
				alice: { autoRecall: false, localProviders: ["acme-local"] },
				bob: { autoRecall: true, localProviders: [] },
			},
		});
		try {
			const notices: { user?: string; kind: string; title: string; body: string }[] = [];
			const host = {
				stores: {
					paths: { data: stub.dataDir },
					settings: { get: stub.rawSettings },
					user: (user: string) => ({
						settings: {
							get: async () => JSON.parse(await stub.raw(stub.userPath(user)) ?? "{}"),
							set: async (value: Record<string, unknown>) => stub.saveUser(user, value),
						},
					}),
				},
				conversations: { meta: async () => ({ owner: "alice", internal: false }) },
				models: { isLocal: () => false },
				users: {
					list: async () => [
						{ user: "alice", admin: true },
						{ user: "bob", admin: false },
					],
				},
				notify: async (input: { user?: string; kind: string; title: string; body: string }) => {
					notices.push(input);
				},
				...stub.host,
			} as never;
			const first = await createRecall(host);
			await vi.waitFor(() => expect(notices).toHaveLength(1));
			await first.harnessShutdown?.({} as never, {} as never);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({
				user: "alice",
				kind: "recall.local-providers-moved",
				title: "Local providers are now set by your admin",
			});
			expect(JSON.parse(await stub.raw(stub.userPath("alice")) ?? "{}")).toEqual({
				autoRecall: false,
			});
			expect(JSON.parse(await stub.raw(stub.userPath("bob")) ?? "{}")).toEqual({
				autoRecall: true,
				localProviders: [],
			});

			const second = await createRecall(host);
			await second.harnessShutdown?.({} as never, {} as never);
			expect(notices).toHaveLength(1);
		} finally {
			await stub.close();
		}
	});
});
