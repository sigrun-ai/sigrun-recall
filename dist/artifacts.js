import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.js";
const ARTIFACT_PASSAGE_SIZE = 2000;
const SYNTHETIC_OUTLINE_SIZE = 4096;
/** Store whole tool results by content hash and index their searchable text. */
export function createArtifactStore(db, dir) {
    function pathForHandle(handle) {
        if (!/^a:[0-9a-f]{16}$/.test(handle))
            return undefined;
        const hash = db.artifactHash(handle);
        return hash === undefined ? undefined : join(dir, `${hash}.txt`);
    }
    return {
        put(text, meta) {
            const hash = createHash("sha256").update(text).digest("hex");
            const handle = `a:${hash.slice(0, 16)}`;
            const path = join(dir, `${hash}.txt`);
            if (!existsSync(path)) {
                mkdirSync(dir, { recursive: true });
                const temporary = `${path}.${process.pid}.tmp`;
                writeFileSync(temporary, text, "utf8");
                renameSync(temporary, path);
            }
            db.putArtifact(hash, Buffer.byteLength(text), {
                title: meta.title,
                url: meta.url,
                createdAt: meta.at,
            });
            const buffer = Buffer.from(text, "utf8");
            for (let offset = 0; offset < buffer.length; offset += ARTIFACT_PASSAGE_SIZE) {
                const bytes = buffer.subarray(offset, offset + ARTIFACT_PASSAGE_SIZE);
                const passage = bytes.toString("utf8");
                db.insertItem({
                    conversationId: meta.conversationId,
                    owner: meta.owner,
                    kind: "artifact",
                    entryId: null,
                    messageIndex: null,
                    blockIndex: 0,
                    offset,
                    length: bytes.length,
                    artifact: handle,
                    doc: null,
                    job: false,
                    cls: "normal",
                    at: meta.at,
                    title: meta.title ?? null,
                }, redact(passage));
            }
            return { handle, bytes: Buffer.byteLength(text) };
        },
        read(handle, offset, length) {
            const path = pathForHandle(handle);
            if (path === undefined || !existsSync(path))
                return undefined;
            const buffer = readFileSync(path);
            let start = Math.min(offset, buffer.length);
            let end = Math.min(offset + length, buffer.length);
            while (start > 0 && start < buffer.length && (buffer[start] & 0xc0) === 0x80)
                start -= 1;
            while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80)
                end -= 1;
            return buffer.subarray(start, end).toString("utf8");
        },
    };
}
/** Return markdown headings, or fixed-size part markers for unheaded text. */
export function outline(text) {
    const headings = [];
    for (const match of text.matchAll(/^#{1,6} (.+)$/gm)) {
        headings.push({
            title: match[1],
            offset: Buffer.byteLength(text.slice(0, match.index)),
        });
    }
    if (headings.length > 0)
        return headings;
    const parts = [];
    for (let offset = 0; offset < Buffer.byteLength(text); offset += SYNTHETIC_OUTLINE_SIZE) {
        parts.push({ title: `part ${parts.length + 1}`, offset });
    }
    return parts;
}
/** Render the retained head and bounded navigation stub for an artifact. */
export function renderStub(text, handle, headBytes) {
    const buffer = Buffer.from(text, "utf8");
    const bytes = buffer.length;
    let headBuffer = buffer.subarray(0, headBytes);
    const lastLine = headBuffer.lastIndexOf(0x0a);
    if (lastLine >= 0)
        headBuffer = headBuffer.subarray(0, lastLine + 1);
    const head = headBuffer.toString("utf8");
    const lines = outline(text)
        .slice(0, 40)
        .map(({ title, offset }) => `- ${title} (offset ${offset})`);
    return `${head}\n\n[recall: full result stored as ${handle}, ${bytes} bytes. Outline:]\n${lines.join("\n")}\nRead more with recall_open("${handle}", {offset}).`;
}
function textOf(result) {
    return (result.output ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
function alreadyPartial(result) {
    const structured = result.structuredOutput;
    if (typeof structured !== "object" || structured === null || Array.isArray(structured)) {
        return false;
    }
    const record = structured;
    return record.truncated === true || record.fullOutputPath !== undefined;
}
/** Replace only large, complete top-level tool output with an artifact stub. */
export function externalize(result, call, deps) {
    if (call.parent !== undefined ||
        result.isError === true ||
        alreadyPartial(result) ||
        result.output === undefined) {
        return undefined;
    }
    const text = textOf(result);
    if (Buffer.byteLength(text) <= deps.thresholdBytes)
        return undefined;
    const url = typeof call.arguments.url === "string" ? call.arguments.url : undefined;
    const saved = deps.store.put(text, {
        title: call.name,
        url,
        conversationId: deps.conversationId,
        owner: deps.owner,
        at: deps.now,
    });
    const nonText = result.output.filter((part) => part.type !== "text");
    return {
        ...result,
        output: [...nonText, { type: "text", text: renderStub(text, saved.handle, 6144) }],
    };
}
