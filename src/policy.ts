import type { Confidentiality } from "./db.js";

/** Return whether an item's confidentiality class permits this model. */
export function mayRead(
	cls: Confidentiality,
	model: { provider: string; id: string } | undefined,
	isLocal: (model: string) => boolean,
): boolean {
	switch (cls) {
		case "normal":
			return true;
		case "local-only":
			return model !== undefined && isLocal(`${model.provider}/${model.id}`);
		default:
			// Unknown classes fail closed as local-only.
			return model !== undefined && isLocal(`${model.provider}/${model.id}`);
	}
}
