import { accessOf } from "@sigrun/shared/access";
/**
 * Return whether an item from `item` may surface to every ordinary reader of
 * `current`. Superuser access is deliberately not part of this decision.
 */
export function audienceCovers(current, item) {
    // Ownerless items are readable by everyone.
    if (item.owner === undefined)
        return true;
    if (current.sharing?.scope === "people") {
        const users = new Set(current.sharing.users);
        if (current.owner !== undefined)
            users.add(current.owner);
        for (const user of users) {
            if (accessOf({ user }, item) === "none")
                return false;
        }
        // An ownerless people current with no users has a vacuous user set:
        // only its groups constrain which items may surface.
        // This empty-reader-set behavior is the mechanical table outcome.
        return (current.sharing.groups ?? []).every((group) => item.sharing?.scope === "household" ||
            (item.sharing?.scope === "people" &&
                item.sharing.groups?.includes(group) === true));
    }
    if (current.sharing?.scope === "household") {
        // Level is deliberately ignored: household grants every identified user
        // read access; its level only widens that access to write.
        return item.sharing?.scope === "household";
    }
    if (current.owner === undefined) {
        // A genuinely unshared, ownerless current is readable by everyone.
        return item.sharing?.scope === "household";
    }
    // Private, including an absent sharing grant: only the owner reads current.
    return accessOf({ user: current.owner }, item) !== "none";
}
