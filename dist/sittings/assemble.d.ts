import type { Message } from "@earendil-works/pi-ai";
import type { PreviousExchange } from "./types.js";
export declare function previousExchange(messages: readonly Message[], beforeIndex: number): PreviousExchange | undefined;
export declare function assembleSitting(messages: readonly Message[], input: {
    boundaryAt: number;
    previous?: PreviousExchange;
    blockText: string;
}): Message[];
