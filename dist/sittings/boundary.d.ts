import type { Message } from "@earendil-works/pi-ai";
export interface SittingOptions {
    minGapMs: number;
    minHistoryTokens: number;
}
export declare function estimateTokens(messages: readonly Message[]): number;
export declare function gapMs(minGapMinutes: number, model: {
    promptCache?: {
        short?: number;
        long?: number;
    };
} | undefined): number;
export declare function isBoundary(messages: readonly Message[], newestUser: number, sinceIndex: number, opts: SittingOptions): boolean;
