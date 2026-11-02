import type { ExtensionRouteContribution } from "@sigrun/sigrun/extension";
import type { Searcher } from "./search.js";
export declare function createRoutes(deps: {
    searcher: Searcher;
    sweep(): Promise<{
        indexed: number;
        sweepAfter: number;
    }>;
}): ExtensionRouteContribution[];
