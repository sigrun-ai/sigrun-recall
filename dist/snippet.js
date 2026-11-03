const SNIPPET_LENGTH = 400;
/** Return a bounded window centred on the first matching query token. */
export function snippetOf(text, tokens) {
    const haystack = text.toLowerCase();
    let firstMatch = -1;
    for (const token of tokens) {
        const index = haystack.indexOf(token.toLowerCase());
        if (index >= 0 && (firstMatch < 0 || index < firstMatch))
            firstMatch = index;
    }
    if (firstMatch < 0)
        return text.slice(0, SNIPPET_LENGTH);
    const start = Math.max(0, Math.min(firstMatch - Math.floor(SNIPPET_LENGTH / 2), text.length - SNIPPET_LENGTH));
    return text.slice(start, start + SNIPPET_LENGTH);
}
