import { createHash } from "node:crypto";

import type { UserMessage } from "@earendil-works/pi-ai";

function textOf(message: UserMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
}

/** Stable identity of a user message for per-message injection reuse. */
export function messageKey(message: UserMessage): string {
	const digest = createHash("sha256").update(textOf(message)).digest("hex").slice(0, 16);
	return `${message.timestamp}:${digest}`;
}
