import type { EntryRecord } from "@earendil-works/pi-durable";
export interface Passage {
    entryId: number;
    messageIndex: number;
    blockIndex: number;
    kind: "turn" | "tool";
    offset: number;
    length: number;
    text: string;
    at: number;
}
/** Split text at the latest paragraph, then line, boundary before the limit. */
export declare function splitText(text: string): {
    text: string;
    offset: number;
}[];
/** Extract bounded, searchable passages from an entry's model messages. */
export declare function passagesOf(entry: EntryRecord): Passage[];
