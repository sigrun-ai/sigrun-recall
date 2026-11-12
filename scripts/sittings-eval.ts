import type { Message } from "@earendil-works/pi-ai";

import { assembleSitting, previousExchange } from "../src/sittings/assemble.ts";
import { estimateTokens, isBoundary, type SittingOptions } from "../src/sittings/boundary.ts";
import { convertChain, readHermes } from "./hermes-convert.ts";

/**
 * Compare the full context at each returning user turn with the sitting-shaped
 * request. The empty block is deliberate: these numbers measure the shape
 * change (dropped pre-boundary turns plus the previous exchange), not the bytes
 * of the real generated table of contents and recall block.
 */
export function measureSittings(
	messages: readonly Message[],
	options: SittingOptions,
): { returns: number; tokensWithout: number[]; tokensWith: number[] } {
	const tokensWithout: number[] = [];
	const tokensWith: number[] = [];
	let sinceIndex = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "user" || !isBoundary(messages, index, sinceIndex, options)) continue;
		const history = messages.slice(0, index + 1);
		tokensWithout.push(estimateTokens(history));
		tokensWith.push(estimateTokens(assembleSitting(history, {
			boundaryAt: message.timestamp,
			previous: previousExchange(history, index),
			blockText: "",
		})));
		sinceIndex = index;
	}
	return { returns: tokensWithout.length, tokensWithout, tokensWith };
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function p90(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * 0.9) - 1]!;
}

function printSummary(label: string, values: readonly number[]): void {
	console.log(`${label}: count=${values.length} median=${median(values)} p90=${p90(values)}`);
}

async function main(): Promise<void> {
	const dbPath = process.argv[2];
	if (dbPath === undefined || process.argv.length !== 3) {
		throw new Error("usage: node --experimental-strip-types scripts/sittings-eval.ts <hermes state.db>");
	}
	const history = readHermes(dbPath);
	const messages: Message[] = [];
	for (const { chain } of history.roots) {
		const converted = convertChain(chain, history.messagesOf);
		for (const line of converted.lines) {
			// Hermes conversion emits pi.user, pi.assistant and pi.tool-result
			// drafts; each carries the corresponding model messages in an array.
			const draft = JSON.parse(line) as { model?: Message[] };
			if (Array.isArray(draft.model)) messages.push(...draft.model);
		}
	}
	messages.sort((a, b) => a.timestamp - b.timestamp);
	const result = measureSittings(messages, { minGapMs: 60 * 60_000, minHistoryTokens: 8_000 });
	console.log(`returns: ${result.returns}`);
	printSummary("without sittings", result.tokensWithout);
	printSummary("with sittings", result.tokensWith);
}

// Importing the pure measurement function never opens a database.
if (process.argv[1]?.endsWith("sittings-eval.ts")) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
