/** Return whether an item's confidentiality class permits this model. */
export function mayRead(cls, model, itemOwnerLocalProviders) {
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
