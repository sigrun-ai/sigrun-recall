import { type Sharing } from "@sigrun/shared/access";
interface ConversationAccess {
    readonly owner?: string;
    readonly sharing?: Sharing;
}
/**
 * Return whether an item from `item` may surface to every ordinary reader of
 * `current`. Superuser access is deliberately not part of this decision.
 */
export declare function audienceCovers(current: ConversationAccess, item: ConversationAccess): boolean;
export {};
