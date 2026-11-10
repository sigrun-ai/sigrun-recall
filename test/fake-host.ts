/**
 * Settings fakes for the declared-settings suite and the existing host
 * literals (settings rework, Task 2).
 *
 * Two shapes, for two different questions:
 *
 * - `createSettingsStub` keeps settings ON DISK in core's own layout (the
 *   shared `settings/<slug>.json`, one user's
 *   `user-settings/<user>/<slug>.json`) and hands the factory a
 *   `host.settings` plus the values those files hold. "An old settings
 *   file still loads" and "a save never touches another user's file" are
 *   then facts about bytes.
 * - `withDeclaredSettings` adds `host.settings` to an existing test's host
 *   literal, reading through THAT literal's stores, so a fixture keeps
 *   deciding what the extension sees — a checked read now instead of the
 *   deleted parser.
 *
 * Both implement the handle with the REAL `checkStoredSettings` (core's
 * defaults and repairs) and count reads, so a test can pin that the factory
 * body performs none.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
	DeclaredSettings,
	SettingsDeclaration,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";

/** The checked-read handle over two `get()` functions (both fakes share it). */
function checked<S, U>(
	declaration: SettingsDeclaration,
	shared: () => Promise<Record<string, unknown>>,
	perUser: (user: string) => Promise<Record<string, unknown>>,
	onRead: () => void,
): DeclaredSettings<S, U> {
	return {
		get: async () => {
			onRead();
			return checkStoredSettings(declaration.schema, await shared()).value as S;
		},
		user: (user: string) => ({
			get: async () => {
				if (declaration.userSchema === undefined) {
					throw new Error("settings.userSchema is not declared");
				}
				onRead();
				return checkStoredSettings(declaration.userSchema, await perUser(user)).value as U;
			},
		}),
	};
}

// ─── the on-disk stub ────────────────────────────────────────────────────

export interface SettingsStub {
	/** The declaration the factory passed to `settings.declare`. */
	readonly declaration: SettingsDeclaration | undefined;
	/** Checked reads performed so far (shared and per user together). */
	readonly reads: number;
	/** Core's `settings` host member. */
	readonly host: Pick<SigrunHost, "settings">;
	/** The shared settings file's raw object (what the factory reads raw). */
	rawSettings(): Promise<Record<string, unknown>>;
	/** The shared settings as the factory's declared schema checks them. */
	read(): Promise<Record<string, unknown>>;
	/** One user's settings as the factory's declared user schema checks them. */
	readUser(user: string): Promise<Record<string, unknown>>;
	/** The shared settings file's path. */
	readonly sharedPath: string;
	/** One directory user's settings file path. */
	readonly userPath: (user: string) => string;
	/** A data directory under the stub's root, for the extension's database. */
	readonly dataDir: string;
	/** Write the shared settings file, as an operator would. */
	save(values: Record<string, unknown>): Promise<void>;
	/** Write one directory user's settings file. */
	saveUser(user: string, values: Record<string, unknown>): Promise<void>;
	/** A file's raw bytes (`undefined` when absent). */
	raw(path: string): Promise<string | undefined>;
	/** Remove the temp root when the stub created it. */
	readonly close: () => Promise<void>;
}

export interface SettingsStubOptions {
	/** The shared settings file's contents; absent means no file. */
	readonly settings?: Record<string, unknown>;
	/** Per-user settings file contents, keyed by user. */
	readonly users?: Readonly<Record<string, Record<string, unknown>>>;
	/** The slug settings resolve under (recall's name equals its package). */
	readonly slug?: string;
}

/** Read a JSON object from a file; an absent or unreadable file is `{}`. */
async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value));
}

/** Build the on-disk stub (ASYNC: the temp root and its files exist up front). */
export async function createSettingsStub(
	options: SettingsStubOptions = {},
): Promise<SettingsStub> {
	const root = await mkdtemp(join(tmpdir(), "recall-host-"));
	const slug = options.slug ?? "recall";
	const sharedPath = join(root, "settings", `${slug}.json`);
	const userPath = (user: string) => join(root, "user-settings", user, `${slug}.json`);
	if (options.settings !== undefined) await writeJson(sharedPath, options.settings);
	for (const [user, values] of Object.entries(options.users ?? {})) {
		await writeJson(userPath(user), values);
	}

	const state: { declaration: SettingsDeclaration | undefined; reads: number } = {
		declaration: undefined,
		reads: 0,
	};
	const declared = (): SettingsDeclaration => {
		if (state.declaration === undefined) throw new Error("the factory declared no settings");
		return state.declaration;
	};
	const count = () => {
		state.reads += 1;
	};

	return {
		get declaration() {
			return state.declaration;
		},
		get reads() {
			return state.reads;
		},
		host: {
			settings: {
				declare<S, U = Record<string, never>>(
					declaration: SettingsDeclaration,
				): DeclaredSettings<S, U> {
					state.declaration = declaration;
					return checked<S, U>(
						declaration,
						() => readJson(sharedPath),
						(user) => readJson(userPath(user)),
						count,
					);
				},
			},
		},
		rawSettings: () => readJson(sharedPath),
		read: async () => checkStoredSettings(declared().schema, await readJson(sharedPath)).value,
		readUser: async (user: string) => {
			const userSchema = declared().userSchema;
			if (userSchema === undefined) throw new Error("the factory declared no user schema");
			return checkStoredSettings(userSchema, await readJson(userPath(user))).value;
		},
		sharedPath,
		userPath,
		dataDir: join(root, "data"),
		save: (values) => writeJson(sharedPath, values),
		saveUser: (user, values) => writeJson(userPath(user), values),
		raw: async (path) => {
			try {
				return await readFile(path, "utf8");
			} catch {
				return undefined;
			}
		},
		close: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

// ─── the host-literal wrapper ────────────────────────────────────────────

/** The stores a host literal supplies (the shape `withDeclaredSettings` reads). */
export interface SettingsStores {
	readonly settings: { get(): Promise<Record<string, unknown>> };
	user?(user: string): { readonly settings: { get(): Promise<Record<string, unknown>> } };
}

/**
 * Add `host.settings` to a host literal, reading through ITS OWN stores, so
 * an existing fixture keeps deciding what the extension sees. A literal with
 * no `user()` throws on a per-user read — exactly where the deleted parser's
 * `host.stores.user(user)` threw — and the extension's own fallback covers it.
 */
export function withDeclaredSettings<T extends { stores: SettingsStores }>(
	host: T,
): T & Pick<SigrunHost, "settings"> {
	const { stores } = host;
	return {
		...host,
		settings: {
			declare<S, U = Record<string, never>>(
				declaration: SettingsDeclaration,
			): DeclaredSettings<S, U> {
				return checked<S, U>(
					declaration,
					() => stores.settings.get(),
					async (user) => {
						const scoped = stores.user?.(user);
						if (scoped === undefined) throw new Error(`no user stores for "${user}"`);
						return scoped.settings.get();
					},
					() => undefined,
				);
			},
		},
	};
}
