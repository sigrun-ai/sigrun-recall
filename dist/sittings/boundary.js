export function estimateTokens(messages) {
    const bytes = messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message.content)), 0);
    return Math.ceil(bytes / 4);
}
export function gapMs(minGapMinutes, model) {
    return Math.max(minGapMinutes * 60_000, (model?.promptCache?.long ?? model?.promptCache?.short ?? 0) * 1_000);
}
export function isBoundary(messages, newestUser, sinceIndex, opts) {
    let previousTimestamp;
    for (let index = 0; index < newestUser; index += 1) {
        const message = messages[index];
        if (message !== undefined && message.role !== "system") {
            previousTimestamp = message.timestamp;
        }
    }
    const newest = messages[newestUser];
    if (previousTimestamp === undefined || newest === undefined)
        return false;
    if (newest.timestamp - previousTimestamp <= opts.minGapMs)
        return false;
    const history = messages
        .slice(sinceIndex, newestUser)
        .filter((message) => message.role !== "system");
    return estimateTokens(history) >= opts.minHistoryTokens;
}
