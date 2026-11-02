import type { Confidentiality } from "./db.js";

/** Return whether an item's confidentiality class permits this model. */
export function mayRead(
	cls: Confidentiality,
	model: { provider: string } | undefined,
	itemOwnerLocalProviders: readonly string[],
): boolean {
	if (cls === "normal") return true;
	return model !== undefined && itemOwnerLocalProviders.includes(model.provider);
}
