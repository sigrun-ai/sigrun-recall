import { entryAttachments } from "@sigrun/shared/turns";
const PASSAGE_LIMIT = 2000;
const TOOL_ARGUMENT_LIMIT = 300;
/** Split text at the latest paragraph, then line, boundary before the limit. */
export function splitText(text) {
    const passages = [];
    let offset = 0;
    while (offset < text.length) {
        const remaining = text.slice(offset);
        if (remaining.length <= PASSAGE_LIMIT) {
            passages.push({ text: remaining, offset });
            break;
        }
        const window = remaining.slice(0, PASSAGE_LIMIT);
        const paragraph = window.lastIndexOf("\n\n");
        const line = window.lastIndexOf("\n");
        const boundary = paragraph >= 0 ? paragraph : line;
        const length = boundary >= 0 ? boundary + (paragraph >= 0 ? 2 : 1) : PASSAGE_LIMIT;
        passages.push({ text: remaining.slice(0, length), offset });
        offset += length;
    }
    return passages;
}
/**
 * Claimed parts of the first model message: every part is omitted except
 * each attachment's first text part, reduced to its one-line marker.
 */
function attachmentTextParts(entry) {
    const content = entry.model?.[0]?.content;
    if (content === undefined || typeof content === "string")
        return new Map();
    const claimed = new Map();
    for (const attachment of entryAttachments(entry)) {
        let markerFound = false;
        for (const partIndex of attachment.parts) {
            if (claimed.has(partIndex))
                continue;
            const part = content[partIndex];
            claimed.set(partIndex, undefined);
            if (part?.type === "text" && !markerFound) {
                claimed.set(partIndex, part.text.split("\n", 1)[0]);
                markerFound = true;
            }
        }
    }
    return claimed;
}
/** Extract bounded, searchable passages from an entry's model messages. */
export function passagesOf(entry) {
    const passages = [];
    const claimedParts = attachmentTextParts(entry);
    for (const [messageIndex, message] of (entry.model ?? []).entries()) {
        if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
            continue;
        }
        const texts = [];
        if (typeof message.content === "string") {
            texts.push({ kind: "turn", text: message.content, blockIndex: 0 });
        }
        else {
            for (const [blockIndex, block] of message.content.entries()) {
                if (messageIndex === 0 && claimedParts.has(blockIndex)) {
                    const marker = claimedParts.get(blockIndex);
                    if (marker !== undefined) {
                        texts.push({ kind: "turn", text: marker, blockIndex });
                    }
                    continue;
                }
                if (block.type === "text") {
                    texts.push({
                        kind: message.role === "toolResult" ? "tool" : "turn",
                        text: message.role === "toolResult" ? block.text.slice(0, PASSAGE_LIMIT) : block.text,
                        blockIndex,
                    });
                }
                else if (message.role === "assistant" && block.type === "toolCall") {
                    texts.push({
                        kind: "tool",
                        text: `${block.name} ${JSON.stringify(block.arguments).slice(0, TOOL_ARGUMENT_LIMIT)}`,
                        blockIndex,
                    });
                }
            }
        }
        for (const { kind, text, blockIndex } of texts) {
            for (const passage of splitText(text)) {
                passages.push({
                    entryId: entry.id,
                    messageIndex,
                    blockIndex,
                    kind,
                    offset: passage.offset,
                    length: passage.text.length,
                    text: passage.text,
                    at: message.timestamp,
                });
            }
        }
    }
    return passages;
}
