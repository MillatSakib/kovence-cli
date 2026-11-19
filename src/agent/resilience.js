"use strict";

/**
 * Repair common malformed JSON emitted by smaller models in tool-call arguments.
 */
function repairToolArguments(rawArgs) {
    if (rawArgs && typeof rawArgs === "object") return rawArgs;
    let src = String(rawArgs ?? "").trim();
    if (!src) return {};

    // Strip markdown ```json fences if wrapped
    src = src
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    try {
        return JSON.parse(src);
    } catch {}

    // Remove trailing commas before } or ]
    let fixed = src.replace(/,\s*([}\]])/g, "$1");
    // Quote bare object keys: { path: "a" } -> { "path": "a" }
    fixed = fixed.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    // Balance missing closing braces/brackets if truncated
    let opensCurly = 0;
    let opensSquare = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < fixed.length; i++) {
        const ch = fixed[i];
        if (esc) {
            esc = false;
            continue;
        }
        if (ch === "\\") {
            esc = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr) continue;
        if (ch === "{") opensCurly += 1;
        else if (ch === "}") opensCurly -= 1;
        else if (ch === "[") opensSquare += 1;
        else if (ch === "]") opensSquare -= 1;
    }
    if (inStr) fixed += '"';
    while (opensSquare > 0) {
        fixed += "]";
        opensSquare -= 1;
    }
    while (opensCurly > 0) {
        fixed += "}";
        opensCurly -= 1;
    }

    try {
        return JSON.parse(fixed);
    } catch (err) {
        throw new Error(`Invalid tool JSON arguments: ${err.message}`);
    }
}

/**
 * Detect repetitive identical tool calls across consecutive steps so agents don't spin forever.
 */
class LoopDetector {
    constructor(maxRepeats = 3) {
        this.maxRepeats = maxRepeats;
        this.history = [];
    }

    record(toolCalls = []) {
        const sig = toolCalls
            .map((tc) => `${tc.function?.name || ""}:${String(tc.function?.arguments || "").replace(/\s+/g, "")}`)
            .sort()
            .join("|");
        if (!sig) return { repeated: false, count: 0 };

        this.history.push(sig);
        let consecutive = 0;
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i] === sig) consecutive += 1;
            else break;
        }
        return {
            repeated: consecutive >= this.maxRepeats,
            count: consecutive,
            signature: sig,
        };
    }
}

module.exports = {
    repairToolArguments,
    LoopDetector,
};
