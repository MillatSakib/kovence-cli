"use strict";

const {
    ensureStorageDirs,
    readJsonSafe,
    atomicWriteJson,
    resolvePaths,
} = require("./paths");

const MAX_GLOBAL_ITEMS = 50;
const MAX_GLOBAL_CHARS = 8000;
const MAX_ITEM_CHARS = 300;
const MAX_SESSION_PINNED = 30;

/**
 * Normalize raw memory entries (strings or provenance objects), dedupe case-insensitively, and enforce caps.
 */
function normalizeMemoryItems(rawItems, maxItems = MAX_GLOBAL_ITEMS, maxTotalChars = MAX_GLOBAL_CHARS) {
    if (!Array.isArray(rawItems)) return [];
    const seen = new Set();
    const out = [];
    let totalChars = 0;

    for (const entry of rawItems) {
        const text = String(typeof entry === "string" ? entry : entry?.text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_ITEM_CHARS);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        if (out.length >= maxItems || totalChars + text.length > maxTotalChars) break;
        seen.add(key);
        totalChars += text.length;
        out.push({
            text,
            createdAt: (typeof entry === "object" && entry?.createdAt) || new Date().toISOString(),
            source: (typeof entry === "object" && entry?.source) || "user",
        });
    }
    return out;
}

function memoryTexts(items) {
    return (Array.isArray(items) ? items : []).map((x) => (typeof x === "string" ? x : x.text));
}

function loadGlobalMemoryEntries(paths = resolvePaths()) {
    const data = readJsonSafe(paths.globalMemoryFile, { items: [] });
    return normalizeMemoryItems(data.items, MAX_GLOBAL_ITEMS, MAX_GLOBAL_CHARS);
}

function loadGlobalMemory(paths = resolvePaths()) {
    return memoryTexts(loadGlobalMemoryEntries(paths));
}

function saveGlobalMemory(items, paths = resolvePaths()) {
    ensureStorageDirs(paths);
    const normalized = normalizeMemoryItems(items, MAX_GLOBAL_ITEMS, MAX_GLOBAL_CHARS);
    atomicWriteJson(paths.globalMemoryFile, {
        updatedAt: new Date().toISOString(),
        items: normalized,
    });
    return normalized;
}

function addGlobalMemory(fact, source = "user", paths = resolvePaths()) {
    const clean = String(fact || "").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
    if (!clean) return false;
    const entries = loadGlobalMemoryEntries(paths);
    if (entries.some((x) => x.text.toLowerCase() === clean.toLowerCase())) return false;
    if (entries.length >= MAX_GLOBAL_ITEMS) return false;
    entries.push({ text: clean, createdAt: new Date().toISOString(), source });
    const after = saveGlobalMemory(entries, paths);
    return after.some((x) => x.text.toLowerCase() === clean.toLowerCase());
}

function removeGlobalMemoryAt(indexZeroBased, paths = resolvePaths()) {
    const entries = loadGlobalMemoryEntries(paths);
    if (indexZeroBased < 0 || indexZeroBased >= entries.length) return null;
    const [removed] = entries.splice(indexZeroBased, 1);
    saveGlobalMemory(entries, paths);
    return removed;
}

function loadProjectMemoryEntries(paths = resolvePaths()) {
    const data = readJsonSafe(paths.projectMemoryFile, { items: [] });
    return normalizeMemoryItems(data.items, MAX_GLOBAL_ITEMS, MAX_GLOBAL_CHARS);
}

function saveProjectMemory(items, paths = resolvePaths()) {
    ensureStorageDirs(paths);
    const normalized = normalizeMemoryItems(items, MAX_GLOBAL_ITEMS, MAX_GLOBAL_CHARS);
    atomicWriteJson(paths.projectMemoryFile, {
        updatedAt: new Date().toISOString(),
        items: normalized,
    });
    return normalized;
}

function addProjectMemory(fact, source = "user", paths = resolvePaths()) {
    const clean = String(fact || "").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
    if (!clean) return false;
    const entries = loadProjectMemoryEntries(paths);
    if (entries.some((x) => x.text.toLowerCase() === clean.toLowerCase())) return false;
    entries.push({ text: clean, createdAt: new Date().toISOString(), source });
    saveProjectMemory(entries, paths);
    return true;
}

const LOCAL_ONLY_RE = /\b(this session|current session|only here|ei session|session memory|local memory)\b/i;
const EXPLICIT_MEMORY_RE =
    /^(?:please\s+)?(?:remember(?:\s+(?:that|this))?|always\s+remember|save\s+(?:this\s+)?(?:to\s+)?(?:global|default|project|session)?\s*memory:?|mone\s+rakh(?:o|be|is)|et[ai]\s+mone\s+rakho)\b/i;
const EXPLICIT_DIRECTIVE_PREF_RE =
    /^(?:from\s+now\s+on(?:,)?\s+|ekhon\s+theke(?:,)?\s+)(?:always|sobsomoy|shobsomoy|never)\s+(?:reply|respond|talk|speak|write|use|format|answer)\b/i;
const QUESTION_RE =
    /\?\s*$|^(why|how|what|when|where|who|which|is|are|can|could|does|do|did|keno|kivabe|ki|kobe|kothay)\b/i;

/**
 * Only classify explicit memory requests so ordinary bug reports containing "always"/"never" never become rules.
 */
function classifyMemoryIntent(userText) {
    const clean = String(userText || "").trim();
    if (!clean || clean.length > MAX_ITEM_CHARS) return null;
    if (clean.startsWith("/") && !/^\/remember\b/i.test(clean)) return null;
    if (QUESTION_RE.test(clean)) return null;

    let body = clean;
    if (/^\/remember\b/i.test(clean)) {
        body = clean.replace(/^\/remember\s*/i, "").trim();
        if (!body) return null;
        const scope = LOCAL_ONLY_RE.test(body) ? "session" : "global";
        return { scope, fact: body, explicitCommand: true };
    }

    if (EXPLICIT_MEMORY_RE.test(clean) || EXPLICIT_DIRECTIVE_PREF_RE.test(clean)) {
        body = clean
            .replace(/^(?:please\s+)?(?:remember(?:\s+(?:that|this))?|always\s+remember|save\s+(?:this\s+)?(?:to\s+)?(?:global|default|project|session)?\s*memory:?)\s*/i, "")
            .trim() || clean;
        const scope = LOCAL_ONLY_RE.test(clean) ? "session" : "global";
        return { scope, fact: body, explicitCommand: false };
    }

    return null;
}

/**
 * Explicitly disabled auto-promotion heuristic for B4 safety; legacy callers get false unless explicit.
 */
function isGlobalMemoryFact() {
    return false;
}

module.exports = {
    MAX_GLOBAL_ITEMS,
    MAX_GLOBAL_CHARS,
    MAX_ITEM_CHARS,
    MAX_SESSION_PINNED,
    normalizeMemoryItems,
    loadGlobalMemoryEntries,
    loadGlobalMemory,
    saveGlobalMemory,
    addGlobalMemory,
    removeGlobalMemoryAt,
    loadProjectMemoryEntries,
    saveProjectMemory,
    addProjectMemory,
    classifyMemoryIntent,
    isGlobalMemoryFact,
};
