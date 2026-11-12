export function previousExchange(messages, beforeIndex) {
    for (let userIndex = beforeIndex - 1; userIndex >= 0; userIndex -= 1) {
        const candidate = messages[userIndex];
        if (candidate?.role !== "user")
            continue;
        for (let index = userIndex + 1; index < beforeIndex; index += 1) {
            const answer = messages[index];
            if (answer?.role !== "assistant")
                continue;
            if (answer.stopReason !== "stop" && answer.stopReason !== "length") {
                continue;
            }
            const text = answer.content.filter((part) => part.type === "text");
            if (text.length === 0)
                continue;
            const user = textOnlyUser(candidate);
            if (user.content.length === 0)
                continue;
            return {
                user,
                assistant: { ...answer, content: text },
            };
        }
    }
    return undefined;
}
function textOnlyUser(message) {
    return {
        ...message,
        content: typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content.filter((part) => part.type === "text"),
    };
}
export function assembleSitting(messages, input) {
    const kept = messages.filter((message) => message.role === "system" || message.timestamp >= input.boundaryAt);
    const firstNonSystem = kept.findIndex((message) => message.role !== "system");
    if (input.previous !== undefined) {
        kept.splice(firstNonSystem === -1 ? kept.length : firstNonSystem, 0, input.previous.user, input.previous.assistant);
    }
    const boundaryIndex = kept.findIndex((message) => message.role === "user" && message.timestamp >= input.boundaryAt);
    // Task 8's caller always keeps the boundary message; without a kept user the block is dropped.
    const boundary = kept[boundaryIndex];
    if (boundary?.role === "user") {
        const block = { type: "text", text: input.blockText };
        const content = typeof boundary.content === "string"
            ? [block, { type: "text", text: boundary.content }]
            : [block, ...boundary.content];
        kept[boundaryIndex] = { ...boundary, content };
    }
    return kept;
}
