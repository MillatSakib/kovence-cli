"use strict";

/**
 * Estimate token count with multi-byte Unicode & JSON structure adjustment (more accurate than chars/4).
 */
function estimateTextTokens(text) {
    const str = String(text || "");
    if (!str) return 0;
    let ascii = 0;
    let nonAscii = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) <= 0x7f) ascii += 1;
        else nonAscii += 1;
    }
    // Non-ASCII scripts (Bengali/CJK/emoji) typically consume ~1-1.5 tokens per UTF-16 char vs ~0.28 for ASCII
    return Math.ceil(ascii * 0.28 + nonAscii * 1.15);
}

function estimateMessageTokens(msg) {
    if (!msg) return 0;
    let tokens = 6; // per-message framing overhead
    if (msg.content)
        tokens += estimateTextTokens(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            tokens += 8 + estimateTextTokens(tc.function?.name) + estimateTextTokens(tc.function?.arguments);
        }
    }
    return tokens;
}

function estimateMessagesTokens(messages) {
    return (Array.isArray(messages) ? messages : []).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Group linear chat history into atomic turns starting at each user message.
 */
function splitHistoryIntoTurns(history) {
    const turns = [];
    let current = null;

    for (const msg of Array.isArray(history) ? history : []) {
        if (!msg || !msg.role) continue;
        if (msg.role === "user") {
            if (current && current.length) turns.push(current);
            current = [msg];
            continue;
        }
        if (!current) {
            // Orphan leading assistant/tool before first user message — keep attached cleanly or discard if tool-only
            if (msg.role === "tool") continue;
            current = [msg];
        } else {
            current.push(msg);
        }
    }
    if (current && current.length) turns.push(current);
    return turns;
}

/**
 * Shrink oversized earlier tool outputs within an oversized active turn without cutting user request or tool pairing.
 */
function compressOversizedTurn(turnMessages, maxMessages) {
    if (turnMessages.length <= maxMessages) return turnMessages;

    const result = turnMessages.map((m) => ({ ...m }));
    // Keep original user request (index 0) and most recent 4 messages intact; prune old tool outputs first
    const keepTailFrom = Math.max(1, result.length - 4);
    for (let i = 1; i < keepTailFrom; i++) {
        if (result[i].role === "tool" && typeof result[i].content === "string" && result[i].content.length > 350) {
            result[i].content =
                `${result[i].content.slice(0, 220)}\n... [pruned earlier tool output: ${result[i].content.length} chars]`;
        }
    }
    return result;
}

/**
 * Turn-aware valid history slicer:
 * - Never drops the active user request in long tool loops (B1)
 * - Never splits assistant.tool_calls from its tool result messages
 * - Respects both message count and token budget relative to contextWindow
 */
function sliceValidHistory(history, maxMessages = 24, maxTokenBudget = 0) {
    const clean = (Array.isArray(history) ? history : []).filter(Boolean);
    if (clean.length === 0) return [];

    const turns = splitHistoryIntoTurns(clean).filter((t) => t[0]?.role === "user");
    if (turns.length === 0) return [];

    const limit = Math.max(2, Number(maxMessages) || 24);
    const chosenTurns = [];
    let totalMsgs = 0;
    let totalTokens = 0;

    // Walk backward turn-by-turn from newest turn to oldest
    for (let i = turns.length - 1; i >= 0; i--) {
        let turn = turns[i];
        const isNewestTurn = i === turns.length - 1;

        if (isNewestTurn && turn.length > limit) {
            turn = compressOversizedTurn(turn, limit);
        }

        const turnTokens = estimateMessagesTokens(turn);
        const fitsMsgs = totalMsgs + turn.length <= limit;
        const fitsTokens = !maxTokenBudget || totalTokens + turnTokens <= maxTokenBudget;

        if (!isNewestTurn && (!fitsMsgs || !fitsTokens)) {
            break;
        }
        chosenTurns.unshift(turn);
        totalMsgs += turn.length;
        totalTokens += turnTokens;
    }

    const flattened = chosenTurns.flat();

    // Final safety guarantee: validate tool_call_id pairing so providers never reject malformed sequences
    const seenToolCallIds = new Set();
    const validated = [];
    for (const m of flattened) {
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc?.id) seenToolCallIds.add(tc.id);
            }
            validated.push(m);
            continue;
        }
        if (m.role === "tool") {
            if (m.tool_call_id && !seenToolCallIds.has(m.tool_call_id)) continue;
        }
        validated.push(m);
    }

    // Remove trailing assistant tool_calls that have no matching tool response (e.g. crashed/errored mid-call)
    while (validated.length > 0) {
        const last = validated[validated.length - 1];
        if (last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
            validated.pop();
        } else {
            break;
        }
    }

    return validated;
}

module.exports = {
    estimateTextTokens,
    estimateMessageTokens,
    estimateMessagesTokens,
    splitHistoryIntoTurns,
    sliceValidHistory,
};
