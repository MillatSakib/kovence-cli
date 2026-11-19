"use strict";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EMOJI_PICT_RE = /\p{Extended_Pictographic}/u;
const ZERO_WIDTH_MARK_RE = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Strip ANSI CSI and OSC escape sequences cleanly for plain-text width calculations.
 */
function stripAnsi(str = "") {
    return String(str || "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?=<>]*[a-zA-Z~]/g, "");
}

function codePointWidth(cp) {
    if (cp === 0) return 0;
    if (
        (cp >= 0x0300 && cp <= 0x036f) ||
        (cp >= 0x0981 && cp <= 0x0983) ||
        cp === 0x09bc ||
        (cp >= 0x09be && cp <= 0x09cd) ||
        cp === 0x09d7 ||
        (cp >= 0x09e2 && cp <= 0x09e3) ||
        cp === 0x200d ||
        cp === 0x200c ||
        (cp >= 0xfe00 && cp <= 0xfe0f)
    ) {
        return 0;
    }
    if (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x231a && cp <= 0x23ff) ||
        (cp >= 0x2600 && cp <= 0x27bf) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x1f300 && cp <= 0x1faff)
    ) {
        return 2;
    }
    return 1;
}

/**
 * Compute visual terminal column width of a single grapheme cluster.
 */
function graphemeWidth(segment) {
    if (!segment) return 0;
    if (EMOJI_PICT_RE.test(segment)) return 2;
    let w = 0;
    for (const ch of segment) {
        if (ZERO_WIDTH_MARK_RE.test(ch)) continue;
        w += codePointWidth(ch.codePointAt(0));
    }
    return Math.min(2, Math.max(w, segment.length > 0 && !ZERO_WIDTH_MARK_RE.test(segment) ? Math.max(1, w) : w));
}

function segmentGraphemes(str) {
    const out = [];
    for (const part of GRAPHEME_SEGMENTER.segment(String(str || ""))) {
        out.push({
            segment: part.segment,
            index: part.index,
            endIndex: part.index + part.segment.length,
            width: graphemeWidth(part.segment),
        });
    }
    return out;
}

function displayWidth(str) {
    const clean = stripAnsi(str);
    let w = 0;
    for (const g of segmentGraphemes(clean)) w += g.width;
    return w;
}

function prevGraphemeBoundary(str, cursor) {
    if (cursor <= 0) return 0;
    let prev = 0;
    for (const part of GRAPHEME_SEGMENTER.segment(String(str || ""))) {
        if (part.index >= cursor) break;
        prev = part.index;
    }
    return prev;
}

function nextGraphemeBoundary(str, cursor) {
    const s = String(str || "");
    if (cursor >= s.length) return s.length;
    for (const part of GRAPHEME_SEGMENTER.segment(s)) {
        const end = part.index + part.segment.length;
        if (end > cursor) return end;
    }
    return s.length;
}

/**
 * Word- and grapheme-aware plain-text wrapper that never breaks surrogate pairs or combining clusters.
 */
function wrapPlain(text, width) {
    const w = Math.max(10, width);
    const out = [];
    for (const rawLine of String(text || "").split(/\r?\n/)) {
        if (!rawLine.length) {
            out.push("");
            continue;
        }
        const graphemes = segmentGraphemes(rawLine);
        let startG = 0;
        while (startG < graphemes.length) {
            let curW = 0;
            let endG = startG;
            let lastSpaceG = -1;
            let lastSoftBreakG = -1;

            while (endG < graphemes.length) {
                const gw = graphemes[endG].width;
                if (curW + gw > w && endG > startG) break;
                curW += gw;
                const ch = graphemes[endG].segment;
                if (ch === " ") lastSpaceG = endG;
                else if (ch === "/" || ch === "?" || ch === "&" || ch === "=") lastSoftBreakG = endG + 1;
                endG += 1;
            }

            if (endG < graphemes.length && lastSpaceG > startG + Math.floor((endG - startG) * 0.15)) {
                out.push(rawLine.slice(graphemes[startG].index, graphemes[lastSpaceG].index));
                startG = lastSpaceG + 1;
                while (startG < graphemes.length && graphemes[startG].segment === " ") startG += 1;
            } else if (
                endG < graphemes.length &&
                lastSoftBreakG > startG + Math.floor((endG - startG) * 0.4) &&
                lastSoftBreakG < endG
            ) {
                out.push(rawLine.slice(graphemes[startG].index, graphemes[lastSoftBreakG].index));
                startG = lastSoftBreakG;
            } else {
                const startChar = graphemes[startG].index;
                const endChar = endG < graphemes.length ? graphemes[endG].index : rawLine.length;
                out.push(rawLine.slice(startChar, endChar));
                startG = endG;
            }
        }
    }
    return out.length ? out : [""];
}

/**
 * Grapheme-safe string clipper ending cleanly with an ellipsis when exceeding maxW columns.
 */
function clipToWidth(str, maxW) {
    const text = String(str || "");
    if (maxW <= 0) return "";
    if (displayWidth(text) <= maxW) return text;
    if (maxW === 1) return "…";

    let out = "";
    let w = 0;
    for (const g of segmentGraphemes(text)) {
        if (w + g.width > maxW - 1) break;
        out += g.segment;
        w += g.width;
    }
    return `${out}…`;
}

function padRight(str, visibleLen, width) {
    return str + " ".repeat(Math.max(0, width - visibleLen));
}

/**
 * Grapheme-safe slice by visual column offsets for mouse selection highlight/extract.
 */
function sliceByVisualColumns(plainLine, startCol, endCol) {
    const line = String(plainLine || "");
    const graphemes = segmentGraphemes(line);
    let col = 0;
    let charStart = line.length;
    let charEnd = line.length;
    let foundStart = false;

    for (const g of graphemes) {
        const nextCol = col + g.width;
        if (!foundStart && nextCol > startCol) {
            charStart = g.index;
            foundStart = true;
        }
        if (col >= endCol) {
            charEnd = g.index;
            break;
        }
        col = nextCol;
        if (nextCol >= endCol) {
            charEnd = g.endIndex;
            break;
        }
    }
    return {
        before: line.slice(0, foundStart ? charStart : line.length),
        selected: foundStart ? line.slice(charStart, Math.max(charStart, charEnd)) : "",
        after: foundStart ? line.slice(Math.max(charStart, charEnd)) : "",
    };
}

module.exports = {
    stripAnsi,
    graphemeWidth,
    segmentGraphemes,
    displayWidth,
    prevGraphemeBoundary,
    nextGraphemeBoundary,
    wrapPlain,
    clipToWidth,
    padRight,
    sliceByVisualColumns,
};
