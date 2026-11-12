import type { UserMessage, AssistantMessage } from "@earendil-works/pi-ai";
import type { Confidentiality } from "../db.js";
export interface PreviousExchange {
    user: UserMessage;
    assistant: AssistantMessage;
}
export interface TocEntry {
    startAt: number;
    title: string | null;
    text: string;
    cls: Confidentiality;
    month?: string;
}
export interface SittingBlock {
    header: string;
    toc: TocEntry[];
    recall: {
        text: string;
        cls: Confidentiality;
        sources: number[];
    };
}
export interface SittingRow {
    conversationId: number;
    startEntryId: number;
    startAt: number;
    boundary: boolean;
    boundaryText: string;
    previous: PreviousExchange | null;
    block: SittingBlock | null;
    title: string | null;
    titleState: "pending" | "done" | "failed" | "none";
}
export interface LineRow {
    conversationId: number;
    startEntryId: number;
    text: string;
    cls: Confidentiality;
    coversThrough: number;
    sealed: boolean;
}
export interface MonthLineRow {
    conversationId: number;
    month: string;
    text: string;
    cls: Confidentiality;
}
