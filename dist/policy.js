/** Return whether an item's confidentiality class permits this model. */
export function mayRead(cls, model, itemOwnerLocalProviders) {
    if (cls === "normal")
        return true;
    return model !== undefined && itemOwnerLocalProviders.includes(model.provider);
}
