import { readFile } from "node:fs/promises";

export interface EvalPair {
	query: string;
	expect: number;
	exclude?: number;
	note?: string;
}

export interface RouteHit {
	conversationId: number;
}

/** Compute ranks, hit@k, and mean reciprocal rank from fake or live route hits. */
export function evaluatePairs(
	pairs: readonly EvalPair[],
	results: readonly (readonly RouteHit[])[],
	k: number,
): { ranks: number[]; hitAtK: number; mrr: number } {
	const ranks = pairs.map((pair, index) => {
		const hits = (results[index] ?? []).filter((hit) => hit.conversationId !== pair.exclude);
		const found = hits.slice(0, k).findIndex((hit) => hit.conversationId === pair.expect);
		return found < 0 ? 0 : found + 1;
	});
	return {
		ranks,
		hitAtK: pairs.length === 0 ? 0 : ranks.filter((rank) => rank > 0).length / pairs.length,
		mrr: pairs.length === 0 ? 0 : ranks.reduce((sum, rank) => sum + (rank === 0 ? 0 : 1 / rank), 0) / pairs.length,
	};
}

function parsePairs(raw: string): EvalPair[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid pairs JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(value)) throw new Error("pairs file must be an array");
	return value.map((candidate, index) => {
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			typeof (candidate as Record<string, unknown>).query !== "string" ||
			typeof (candidate as Record<string, unknown>).expect !== "number" ||
			!Number.isInteger((candidate as Record<string, unknown>).expect) ||
			((candidate as Record<string, unknown>).exclude !== undefined &&
				(typeof (candidate as Record<string, unknown>).exclude !== "number" ||
					!Number.isInteger((candidate as Record<string, unknown>).exclude) ||
					(candidate as Record<string, number>).exclude <= 0)) ||
			((candidate as Record<string, unknown>).note !== undefined &&
				typeof (candidate as Record<string, unknown>).note !== "string")
		) {
			throw new Error(`invalid pair at index ${index}: expected {query: string, expect: integer, exclude?: positive integer, note?: string}`);
		}
		return candidate as EvalPair;
	});
}

async function main(): Promise<void> {
	let baseUrl: string | undefined;
	let pairsPath: string | undefined;
	let k = 5;
	for (let index = 2; index < process.argv.length; index += 1) {
		const flag = process.argv[index];
		if (flag === "--base-url") baseUrl = process.argv[++index];
		else if (flag === "--pairs") pairsPath = process.argv[++index];
		else if (flag === "--k") k = Number(process.argv[++index]);
		else throw new Error(`unknown argument: ${flag}`);
	}
	if (baseUrl === undefined || pairsPath === undefined) {
		throw new Error("--base-url <url> and --pairs <file> are required");
	}
	if (!Number.isInteger(k) || k <= 0) throw new Error("--k must be a positive integer");
	const token = process.env.SIGRUN_TOKEN;
	if (token === undefined || token === "") {
		throw new Error("SIGRUN_TOKEN must contain a per-user API token");
	}
	const headers = { authorization: `Bearer ${token}` };
	const whoamiResponse = await fetch(`${baseUrl}/v1/auth/whoami`, { headers });
	if (!whoamiResponse.ok) throw new Error(`whoami returned ${whoamiResponse.status}`);
	const whoami = (await whoamiResponse.json()) as { user?: string; service?: boolean };
	if (whoami.service === true || whoami.user === undefined) {
		throw new Error("refusing to evaluate as a service token or without a user; use a per-user SIGRUN_TOKEN");
	}
	console.log(`evaluating as ${whoami.user}`);
	const pairs = parsePairs(await readFile(pairsPath, "utf8"));
	const results: RouteHit[][] = [];
	for (const pair of pairs) {
		try {
			const response = await fetch(
				`${baseUrl}/v1/ext/recall/search?q=${encodeURIComponent(pair.query)}&limit=${k}${pair.exclude === undefined ? "" : `&exclude=${pair.exclude}`}`,
				{ headers },
			);
			if (!response.ok) throw new Error(`search returned ${response.status}`);
			const body = (await response.json()) as { hits?: RouteHit[] };
			if (!Array.isArray(body.hits)) throw new Error("search response has no hits array");
			results.push(body.hits);
		} catch (error) {
			console.error(`${pair.query}: ${error instanceof Error ? error.message : String(error)}`);
			results.push([]);
		}
	}
	const metrics = evaluatePairs(pairs, results, k);
	console.log("query\texpect\trank\tnote");
	for (const [index, pair] of pairs.entries()) {
		const query = pair.query.length > 50 ? `${pair.query.slice(0, 49)}…` : pair.query;
		console.log(`${query}\t${pair.expect}\t${metrics.ranks[index] || "-"}\t${pair.note ?? ""}`);
	}
	console.log(`hit@${k}: ${metrics.hitAtK.toFixed(3)}`);
	console.log(`MRR: ${metrics.mrr.toFixed(3)}`);
}

// Importing the module for its pure metrics never contacts a service.
if (process.argv[1]?.endsWith("recall-eval.ts")) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
