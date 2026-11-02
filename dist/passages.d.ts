import type { EntryRecord } from "@earendil-works/pi-durable";
export interface Passage {
    entryId: number;
    messageIndex: number;
    kind: "turn" | "tool";
    offset: number;
    length: number;
    text: string;
    at: number;
}
/** Extract bounded, searchable passages from an entry's model messages. */
export declare function passagesOf(entry: EntryRecord): Passage[];
