import type { Confidentiality } from "./db.js";
/** Return whether an item's confidentiality class permits this model. */
export declare function mayRead(cls: Confidentiality, model: {
    provider: string;
    id: string;
} | undefined, isLocal: (model: string) => boolean): boolean;
