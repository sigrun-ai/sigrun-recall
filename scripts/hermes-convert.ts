import { DatabaseSync } from "node:sqlite";

import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";

export interface HermesSession {
	id: string;
	source: string;
	model: string | null;
	startedAt: number;
	parentSessionId: string | null;
	title: string | null;
}

export interface HermesMessage {
	role: "user" | "assistant" | "tool" | string;
	content: string | null;
	toolCalls: string | null;
	toolCallId: string | null;
	toolName: string | null;
	timestamp: number;
}

const ROOT_SOURCES = new Set(["webui", "cli", "tui", "signal"]);

/** Select interactive roots and their transitive continuations in start order. */
export function selectRoots(
	sessions: readonly HermesSession[],
): { root: HermesSession; chain: HermesSession[] }[] {
	const byParent = new Map<string, HermesSession[]>();
	for (const session of sessions) {
		if (session.parentSessionId === null) continue;
		const children = byParent.get(session.parentSessionId) ?? [];
		children.push(session);
		byParent.set(session.parentSessionId, children);
	}
	const roots = sessions
		.filter((session) => session.parentSessionId === null && ROOT_SOURCES.has(session.source))
		.sort((a, b) => a.startedAt - b.startedAt);
	return roots.map((root) => {
		const chain: HermesSession[] = [];
		function visit(session: HermesSession): void {
			chain.push(session);
			for (const child of (byParent.get(session.id) ?? []).sort((a, b) => a.startedAt - b.startedAt)) {
				visit(child);
			}
		}
		visit(root);
		return { root, chain };
	});
}

function toolCalls(raw: string | null): ToolCall[] {
	if (raw === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((value): ToolCall[] => {
		if (typeof value !== "object" || value === null) return [];
		const record = value as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
		const rawArguments = record.function?.arguments;
		let args: JsonObject = {};
		let argumentsError: string | undefined;
		if (typeof rawArguments === "string") {
			try {
				const parsedArguments = JSON.parse(rawArguments);
				if (typeof parsedArguments === "object" && parsedArguments !== null && !Array.isArray(parsedArguments)) {
					// SAFETY: Hermes [OI] tool arguments are JSON objects.
					args = parsedArguments as JsonObject;
				}
			} catch (error) {
				argumentsError = error instanceof Error ? error.message : String(error);
			}
		}
		return [{
			type: "toolCall",
			id: typeof record.id === "string" ? record.id : "",
			name: typeof record.function?.name === "string" ? record.function.name : "",
			arguments: args,
			...(argumentsError === undefined ? {} : { argumentsError }),
		}];
	});
}

function convertMessage(message: HermesMessage, session: HermesSession): unknown | undefined {
	const timestamp = message.timestamp * 1000;
	if (message.role === "user") {
		return {
			kind: "pi.user",
			model: [{
				role: "user",
				content: [{ type: "text", text: message.content ?? "" }],
				timestamp,
			}],
		};
	}
	if (message.role === "assistant") {
		const calls = toolCalls(message.toolCalls);
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				...(message.content === null || message.content === ""
					? []
					: [{ type: "text" as const, text: message.content }]),
				...calls,
			],
			api: "openai-completions",
			provider: "hermes-import",
			model: session.model ?? "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: calls.length > 0 ? "toolUse" : "stop",
			timestamp,
		};
		return { kind: "pi.assistant", model: [assistant] };
	}
	if (message.role === "tool") {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: message.toolCallId ?? "",
			toolName: message.toolName ?? "",
			content: [{ type: "text", text: message.content ?? "" }],
			isError: false,
			timestamp,
		};
		return { kind: "pi.tool-result", model: [result] };
	}
	return undefined;
}

/** Convert one complete chain to sigrun's import JSONL entry drafts. */
export function convertChain(
	chain: readonly HermesSession[],
	messagesOf: (id: string) => HermesMessage[],
): { lines: string[]; name: string; bytes: number } {
	const lines: string[] = [];
	let firstUser: string | undefined;
	for (const session of chain) {
		for (const message of messagesOf(session.id)) {
			if (message.role === "user" && firstUser === undefined) {
				firstUser = (message.content ?? "").replace(/\s+/g, " ").trim();
			}
			const converted = convertMessage(message, session);
			if (converted !== undefined) lines.push(JSON.stringify(converted));
		}
	}
	const root = chain[0];
	const title = root?.title?.trim();
	const name = title !== undefined && title !== ""
		? title
		: firstUser !== undefined && firstUser !== ""
			? firstUser.slice(0, 60)
			: `Hermes session ${root?.id ?? "unknown"}`;
	const bytes = Buffer.byteLength(lines.join("\n") + "\n");
	return { lines, name, bytes };
}

/** Read-only synthetic/real Hermes database access used by tests and the CLI. */
export function readHermes(path: string): {
	sessions: HermesSession[];
	roots: { root: HermesSession; chain: HermesSession[] }[];
	messagesOf(id: string): HermesMessage[];
} {
	const db = new DatabaseSync(path, { readOnly: true });
	// SAFETY: SELECT aliases project the declared Hermes session/message columns.
	const sessions = (db.prepare(
		`SELECT id, source, model, started_at AS startedAt,
		 parent_session_id AS parentSessionId, title FROM sessions`,
	).all() as unknown as HermesSession[]);
	const statement = db.prepare(
		`SELECT role, content, tool_calls AS toolCalls, tool_call_id AS toolCallId,
		 tool_name AS toolName, timestamp FROM messages
		 WHERE session_id = ? AND (active = 1 OR compacted = 1) ORDER BY timestamp, id`,
	);
	return {
		sessions,
		roots: selectRoots(sessions),
		messagesOf(id) {
			// SAFETY: the fixed SELECT aliases match HermesMessage's fields.
			return statement.all(id) as unknown as HermesMessage[];
		},
	};
}
