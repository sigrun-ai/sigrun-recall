import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import { RecallDb } from "./db.js";
/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 */
export default function createRecall(host, deps = {}) {
    let database;
    // Capture/search surfaces added by later tasks share this one lazy handle.
    // Core does not create paths.data; RecallDb.open creates its parent.
    function db() {
        database ??= (deps.openDb ?? RecallDb.open)(join(host.stores.paths.data, "recall.db"));
        return database;
    }
    void db;
    return {
        extension: defineExtension({ name: "@sigrun/recall" }),
    };
}
