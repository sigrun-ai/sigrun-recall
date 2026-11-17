import type { UserMessage } from "@earendil-works/pi-ai";
/** Stable identity of a user message for per-message injection reuse. */
export declare function messageKey(message: UserMessage): string;
