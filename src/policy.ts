import type { Confidentiality } from "./db.js";

/** Return whether an item's confidentiality class permits this model. */
export function mayRead(
	cls: Confidentiality,
	model: { provider: string } | undefined,
	itemOwnerLocalProviders: readonly string[],
): boolean {
	switch (cls) {
		case "normal":
			return true;
		case "local-only":
			return model !== undefined && itemOwnerLocalProviders.includes(model.provider);
		default:
			// Unknown classes fail closed as local-only.
			return model !== undefined && itemOwnerLocalProviders.includes(model.provider);
	}
}
