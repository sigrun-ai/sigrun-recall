import { readFile, writeFile } from "node:fs/promises";

import { convertChain, readHermes, ROOT_SOURCES, type HermesMessage } from "./hermes-convert.js";

interface Options {
	db: string;
	baseUrl?: string;
	state: string;
	dryRun: boolean;
	limit?: number;
}

function options(argv: readonly string[]): Options {
	let db: string | undefined;
	let baseUrl: string | undefined;
	let state = "./hermes-import-state.json";
	let dryRun = false;
	let limit: number | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--dry-run") dryRun = true;
		else if (flag === "--db") db = argv[++index];
		else if (flag === "--base-url") baseUrl = argv[++index];
		else if (flag === "--state") state = argv[++index];
		else if (flag === "--limit") {
			const parsed = Number(argv[++index]);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				throw new Error("--limit must be a positive integer");
			}
			limit = parsed;
		}
		else throw new Error(`unknown argument: ${flag}`);
	}
	if (db === undefined) throw new Error("--db <path> is required");
	if (!dryRun && baseUrl === undefined) throw new Error("--base-url <url> is required unless --dry-run");
	return { db, baseUrl, state, dryRun, limit };
}

function messageDates(messages: readonly HermesMessage[]): { first?: number; last?: number } {
	return {
		first: messages[0] === undefined ? undefined : messages[0].timestamp * 1000,
		last: messages.at(-1) === undefined ? undefined : messages.at(-1)!.timestamp * 1000,
	};
}

function date(value: number | undefined): string {
	return value === undefined ? "-" : new Date(value).toISOString();
}

async function main(): Promise<void> {
	const opts = options(process.argv.slice(2));
	const history = readHermes(opts.db);
	const selected = history.roots.slice(0, opts.limit);
	const converted = selected.map(({ root, chain }) => {
		const messages = chain.flatMap((session) => history.messagesOf(session.id));
		return { root, sessions: chain.length, messages, ...convertChain(chain, history.messagesOf) };
	});
	if (opts.dryRun) {
		for (const chain of converted) {
			const dates = messageDates(chain.messages);
			console.log(`${chain.root.id}\tsessions=${chain.sessions}\tmessages=${chain.messages.length}\tbytes=${chain.bytes}\tname=${JSON.stringify(chain.name)}\tfirst=${date(dates.first)}\tlast=${date(dates.last)}`);
		}
		const all = converted.flatMap((chain) => chain.messages);
		console.log(`TOTAL chains=${converted.length} messages=${all.length} bytes=${converted.reduce((sum, chain) => sum + chain.bytes, 0)} first=${date(messageDates(all).first)} last=${date(messageDates(all).last)}`);
		const excluded = new Map<string, number>();
		for (const session of history.sessions) {
			if (session.parentSessionId === null && !ROOT_SOURCES.has(session.source)) {
				excluded.set(session.source, (excluded.get(session.source) ?? 0) + 1);
			}
		}
		for (const [source, count] of [...excluded].sort()) {
			console.log(`EXCLUDED source=${source} roots=${count}`);
		}
		return;
	}

	const token = process.env.SIGRUN_TOKEN;
	if (token === undefined || token === "") throw new Error("SIGRUN_TOKEN must contain a per-user API token");
	const preflight = await fetch(`${opts.baseUrl}/v1/auth/whoami`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!preflight.ok) throw new Error(`whoami returned ${preflight.status}`);
	const whoami = (await preflight.json()) as { user?: string; service?: boolean };
	if (whoami.service === true || whoami.user === undefined) {
		throw new Error("refusing to import as a service token or without a user; use a per-user SIGRUN_TOKEN");
	}
	console.log(`importing as ${whoami.user}`);
	await importChains(converted, opts, token, fetch);
}

export async function importChains(
	converted: readonly { root: { id: string }; name: string; lines: string[]; bytes: number }[],
	opts: { baseUrl?: string; state: string },
	token: string,
	fetchImpl: typeof fetch,
): Promise<void> {
	const headers = { authorization: `Bearer ${token}` };
	let state: Record<string, number | { id: number; meta: boolean }> = {};
	try {
		state = JSON.parse(await readFile(opts.state, "utf8")) as Record<string, number | { id: number; meta: boolean }>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const chain of converted) {
		// An empty chain (no importable messages — e.g. a stub session)
		// would 400 invalid_body on the import route; nothing to import.
		if (chain.lines.length === 0) continue;
		const existing = state[chain.root.id];
		if (typeof existing === "number" || existing?.meta === true) continue;
		if (existing !== undefined) {
			const meta = await fetchImpl(`${opts.baseUrl}/v1/conversations/${existing.id}/meta`, {
				method: "PATCH",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ name: chain.name, archived: true }),
			});
			if (!meta.ok) throw new Error(`metadata ${chain.root.id} returned ${meta.status}`);
			state[chain.root.id] = existing.id;
			await writeFile(opts.state, JSON.stringify(state, null, 2) + "\n");
			continue;
		}
		const response = await fetchImpl(`${opts.baseUrl}/v1/conversations/import`, {
			method: "POST",
			headers: { ...headers, "content-type": "text/plain" },
			body: chain.lines.join("\n") + "\n",
		});
		if (response.status === 413) {
			console.error(`chain ${chain.root.id} exceeded import limit (${chain.bytes} bytes); continuing`);
			continue;
		}
		if (!response.ok) throw new Error(`import ${chain.root.id} returned ${response.status}`);
		const imported = (await response.json()) as { id?: number; conversationId?: number };
		const id = imported.id ?? imported.conversationId;
		if (id === undefined) throw new Error(`import ${chain.root.id} returned no conversation id`);
		state[chain.root.id] = { id, meta: false };
		await writeFile(opts.state, JSON.stringify(state, null, 2) + "\n");
		const meta = await fetchImpl(`${opts.baseUrl}/v1/conversations/${id}/meta`, {
			method: "PATCH",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ name: chain.name, archived: true }),
		});
		if (!meta.ok) throw new Error(`metadata ${chain.root.id} returned ${meta.status}`);
		state[chain.root.id] = id;
		await writeFile(opts.state, JSON.stringify(state, null, 2) + "\n");
	}
}

if (process.argv[1]?.endsWith("hermes-import.ts") && process.execArgv.some((arg) => arg.includes("tsx"))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
