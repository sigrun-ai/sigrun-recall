/**
 * Recall's declared settings (settings rework, Task 2): the shared
 * `externalizeBytes` key and the per-user `autoRecall` / `localProviders`
 * pair, as JSON Schema. These tests pin the contract the deleted
 * `resolveSettings`/`resolveUserSettings` parsers implemented by hand —
 * every default, and what a malformed stored value becomes — plus the two
 * facts the schema itself decides: per-user settings stay per user, and
 * there is no `embedding` group to configure (embeddings come from
 * `host.embeddings`).
 */

import { describe, expect, test } from "vitest";
import { assertDrawable, checkStoredSettings } from "@sigrun/sigrun/settings-schema";

import createRecall from "../src/index.js";
import {
	RECALL_SETTINGS_SCHEMA,
	RECALL_USER_SETTINGS_SCHEMA,
	type UserRecallSettings,
} from "../src/settings-schema.js";
import { createSettingsStub, type SettingsStub } from "./fake-host.js";

/** The defaults the deleted parsers filled in, verbatim. */
const DEFAULT_SHARED = { externalizeBytes: 24_576 };
const DEFAULT_USER: UserRecallSettings = { autoRecall: true, localProviders: [] };

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
				// Kept raw for the v4 migration label; the declared handle is the
				// extension's only checked read.
				settings: { get: stub.rawSettings },
			},
			conversations: {
				meta: async () => ({ owner: "alice", internal: false }),
			},
			// The one-boot "embeddings moved" notice: an empty directory, so it
			// goes out userless and this fake swallows it.
			users: { list: async () => [] },
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

	test("defaults match the old parser", async () => {
		// resolveSettings() returned { externalizeBytes: 24576 } and
		// resolveUserSettings() returned { autoRecall: true, localProviders: [] }
		// for a settings file with no keys.
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
				// The shape README.md documents.
				settings: { externalizeBytes: 50 },
				users: {
					alice: { autoRecall: false, localProviders: ["acme-local"] },
					bob: {},
				},
			},
			async (stub, result) => {
				expect(await stub.read()).toEqual({ externalizeBytes: 50 });
				expect(await stub.readUser("alice")).toEqual({
					autoRecall: false,
					localProviders: ["acme-local"],
				});
				// A user with no file at all gets every default.
				expect(await stub.readUser("bob")).toEqual(DEFAULT_USER);

				// And the value is the one the live hook externalizes with: a
				// 200-byte result clears a 50-byte threshold, so it comes back as a
				// handle rather than the whole text.
				const replaced = await afterToolOf(result)({
					call: { type: "toolCall", id: "call-1", name: "web_fetch", arguments: {} },
					result: { output: [{ type: "text", text: "y".repeat(200) }] },
				});
				expect(replaced).toMatch(/a:[0-9a-f]{16}/);
			},
		);
	});

	test("a malformed value falls back to its default (the old leniency)", () => {
		// externalizeBytes: the old parser took any INTEGER above zero and
		// warned off everything else, so the integer type and the `> 0` bound
		// reproduce it (a fraction warned then too).
		for (const externalizeBytes of ["big", 0, -1, 1.5, null, [], {}]) {
			expect(
				checkStoredSettings(RECALL_SETTINGS_SCHEMA, { externalizeBytes }).value,
			).toEqual(DEFAULT_SHARED);
		}
		expect(
			checkStoredSettings(RECALL_SETTINGS_SCHEMA, { externalizeBytes: 1 }).value,
		).toEqual({ externalizeBytes: 1 });

		// autoRecall: only a boolean was honoured; everything else read as `true`.
		for (const autoRecall of ["yes", 1, 0, null, []]) {
			expect(
				checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, { autoRecall }).value,
			).toEqual(DEFAULT_USER);
		}
		expect(
			checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, { autoRecall: false }).value,
		).toEqual({ autoRecall: false, localProviders: [] });

		// localProviders: the old parser replaced the WHOLE list when any entry
		// was not a non-empty string. Core repairs at the smallest failing node,
		// so a blank entry alone is dropped and the rest of the list survives —
		// strictly less destructive, and named in the admin notice.
		expect(
			checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, {
				localProviders: ["acme-local", "", "acme-other"],
			}).value,
		).toEqual({ autoRecall: true, localProviders: ["acme-local", "acme-other"] });
		// A non-array value has no per-entry repair: the whole key falls back.
		for (const localProviders of ["acme-local", 5, null, {}]) {
			expect(
				checkStoredSettings(RECALL_USER_SETTINGS_SCHEMA, { localProviders }).value,
			).toEqual(DEFAULT_USER);
		}
	});

	test("user settings stay per user", async () => {
		await withRecall(
			{
				users: {
					alice: { autoRecall: false, localProviders: ["alice-local"] },
					bob: { autoRecall: true, localProviders: ["bob-local"] },
				},
			},
			async (stub) => {
				const bobBefore = await stub.raw(stub.userPath("bob"));
				await stub.saveUser("alice", {
					autoRecall: true,
					localProviders: ["alice-changed"],
				});
				expect(await stub.readUser("alice")).toEqual({
					autoRecall: true,
					localProviders: ["alice-changed"],
				});
				expect(await stub.readUser("bob")).toEqual({
					autoRecall: true,
					localProviders: ["bob-local"],
				});
				// Alice's save never wrote bob's file.
				expect(await stub.raw(stub.userPath("bob"))).toBe(bobBefore);
			},
		);
	});

	test("absent embedding group means no embeddings", async () => {
		// The group is in neither schema: embeddings come from
		// `host.embeddings`, so no settings file can name a model, an endpoint,
		// a locality flag or a timeout.
		expect(Object.keys(RECALL_SETTINGS_SCHEMA.properties ?? {})).toEqual([
			"externalizeBytes",
		]);
		expect(Object.keys(RECALL_USER_SETTINGS_SCHEMA.properties ?? {})).toEqual([
			"autoRecall",
			"localProviders",
		]);

		// A legacy file still loads: the group survives as an unknown stored key
		// (the Advanced pane lists it), so nothing is lost and nothing is
		// resurrected as behaviour.
		const embedding = {
			url: "https://api.openai.com/v1",
			model: "text-embedding-3-small",
			local: false,
			timeoutMs: 800,
		};
		await withRecall({ settings: { externalizeBytes: 512, embedding } }, async (stub) => {
			expect(await stub.read()).toEqual({ externalizeBytes: 512, embedding });
			// The raw read behind the one-boot migration notice still sees it.
			expect(await stub.rawSettings()).toEqual({ externalizeBytes: 512, embedding });
		});
	});

	test("the factory declares both schemas and reads none in its body", async () => {
		// A factory-time read through the declared handle resolves the loader's
		// provisional slug rather than the file the settings page writes, so the
		// declaration happens in the body and the values are read on use.
		await withRecall({ settings: { externalizeBytes: 1024 } }, async (stub) => {
			expect(stub.declaration).toBeDefined();
			expect(stub.reads).toBe(0);
		});
	});
});
