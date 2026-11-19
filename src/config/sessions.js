"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { safeId, ensureStorageDirs, readJsonSafe, atomicWriteJson, resolvePaths } = require("./paths");

function createEmptySession(id, model = "") {
    const now = new Date().toISOString();
    return {
        id: safeId(id),
        title: "",
        createdAt: now,
        updatedAt: now,
        model,
        agentMode: null,
        summaryMemory: "",
        pinnedMemory: [],
        todos: [],
        history: [],
        stats: { requests: 0, totalMs: 0, promptTokens: 0, completionTokens: 0 },
    };
}

function sessionPath(id, paths = resolvePaths()) {
    return path.join(paths.sessionsDir, `${safeId(id)}.json`);
}

function loadSession(id, defaultModel = "", paths = resolvePaths()) {
    const cleanId = safeId(id);
    const data = readJsonSafe(sessionPath(cleanId, paths), null);
    if (!data) return createEmptySession(cleanId, defaultModel);
    return {
        ...createEmptySession(cleanId, defaultModel),
        ...data,
        id: cleanId,
        pinnedMemory: Array.isArray(data.pinnedMemory) ? data.pinnedMemory : [],
        todos: Array.isArray(data.todos) ? data.todos : [],
        history: Array.isArray(data.history) ? data.history : [],
        stats: { requests: 0, totalMs: 0, promptTokens: 0, completionTokens: 0, ...(data.stats || {}) },
    };
}

function saveSession(session, paths = resolvePaths()) {
    ensureStorageDirs(paths);
    session.updatedAt = new Date().toISOString();
    atomicWriteJson(sessionPath(session.id, paths), session);
}

function renameSession(session, newId, paths = resolvePaths()) {
    const oldId = safeId(session.id);
    const cleanNewId = safeId(newId);
    if (!cleanNewId) throw new Error("Invalid session name.");
    const oldFile = sessionPath(oldId, paths);
    session.id = cleanNewId;
    saveSession(session, paths);
    if (oldId !== cleanNewId && fs.existsSync(oldFile)) {
        try {
            fs.unlinkSync(oldFile);
        } catch {
            // Non-fatal if already removed.
        }
    }
    return cleanNewId;
}

function toLocalDateKey(isoStr) {
    const d = isoStr ? new Date(isoStr) : null;
    if (!d || Number.isNaN(d.getTime())) return "unknown";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateGroupLabel(dateKey, now = new Date()) {
    if (!dateKey || dateKey === "unknown") return "Unknown Date";
    const todayKey = toLocalDateKey(now.toISOString());
    const yest = new Date(now.getTime() - 86400000);
    const yestKey = toLocalDateKey(yest.toISOString());
    if (dateKey === todayKey) return `Today (${dateKey})`;
    if (dateKey === yestKey) return `Yesterday (${dateKey})`;
    return dateKey;
}

function groupSessionsByDate(sessions, now = new Date()) {
    const groups = new Map();
    for (const s of sessions || []) {
        const key = s.dateKey || toLocalDateKey(s.updatedAt || s.createdAt);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
    }
    return [...groups.entries()]
        .filter(([, list]) => list.length > 0)
        .sort(([a], [b]) => {
            if (a === "unknown") return 1;
            if (b === "unknown") return -1;
            return b.localeCompare(a);
        })
        .map(([dateKey, list]) => ({
            dateKey,
            dateLabel: formatDateGroupLabel(dateKey, now),
            sessions: list,
        }));
}

function suggestSessionIdFromPrompt(promptText, paths = resolvePaths()) {
    const cleaned = String(promptText || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const rawSlug = cleaned
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 36)
        .replace(/-+$/g, "");
    const base = rawSlug || "chat";
    let candidate = safeId(base);
    let n = 2;
    while (fs.existsSync(sessionPath(candidate, paths)) && n < 1000) {
        candidate = safeId(`${base}-${n}`);
        n++;
    }
    return candidate;
}

function listSessions(paths = resolvePaths()) {
    ensureStorageDirs(paths);
    if (!fs.existsSync(paths.sessionsDir)) return [];
    return fs
        .readdirSync(paths.sessionsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
            const id = f.replace(/\.json$/, "");
            const data = readJsonSafe(path.join(paths.sessionsDir, f), {});
            const hist = Array.isArray(data.history) ? data.history : [];
            const lastUser = [...hist].reverse().find((m) => m.role === "user" && m.content);
            const rawPreview = data.title || (lastUser ? String(lastUser.content) : "");
            const preview = rawPreview.replace(/\s+/g, " ").trim().slice(0, 48);
            const updatedAt = data.updatedAt || data.createdAt || "";
            return {
                id,
                title: data.title || "",
                createdAt: data.createdAt || "",
                updatedAt,
                dateKey: toLocalDateKey(updatedAt),
                messages: hist.length,
                hasSummary: Boolean(data.summaryMemory),
                preview,
            };
        })
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function deleteSession(id, paths = resolvePaths()) {
    const file = sessionPath(id, paths);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
}

/**
 * Delete session files whose `updatedAt` (or `createdAt`) timestamp is older than
 * `retentionDays` days.  Pass 0 (or null/undefined) to skip cleanup entirely.
 * Returns the number of sessions deleted.
 */
function cleanupOldSessions(retentionDays, paths = resolvePaths(), activeSessionId = "") {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    ensureStorageDirs(paths);
    if (!fs.existsSync(paths.sessionsDir)) return 0;
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    let deleted = 0;
    const files = fs.readdirSync(paths.sessionsDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
        const id = f.replace(/\.json$/, "");
        if (id === activeSessionId) continue; // never delete current session
        const full = path.join(paths.sessionsDir, f);
        try {
            const data = readJsonSafe(full, null);
            const stamp = data?.updatedAt || data?.createdAt || "";
            if (!stamp) continue;
            const ts = new Date(stamp).getTime();
            if (!Number.isFinite(ts)) continue;
            if (ts < cutoffMs) {
                fs.unlinkSync(full);
                deleted++;
            }
        } catch {
            // Non-fatal: skip unreadable file.
        }
    }
    return deleted;
}

function forkSession(sourceSession, newId, paths = resolvePaths()) {
    const cleanNewId = safeId(newId);
    if (!cleanNewId) throw new Error("Invalid fork session name.");
    const now = new Date().toISOString();
    const cloned = JSON.parse(JSON.stringify(sourceSession));
    cloned.id = cleanNewId;
    cloned.createdAt = now;
    cloned.updatedAt = now;
    if (cloned.title) cloned.title = `${cloned.title} (fork)`;
    saveSession(cloned, paths);
    return cloned;
}

function loadInputHistory(paths = resolvePaths()) {
    const data = readJsonSafe(paths.inputHistoryFile, []);
    return Array.isArray(data)
        ? data.filter((x) => typeof x === "string" && x.trim() && !x.trim().startsWith("/")).slice(-200)
        : [];
}

function saveInputHistory(items, paths = resolvePaths()) {
    ensureStorageDirs(paths);
    const clean = (Array.isArray(items) ? items : [])
        .filter((x) => typeof x === "string" && x.trim() && !x.trim().startsWith("/"))
        .slice(-200);
    atomicWriteJson(paths.inputHistoryFile, clean);
}

module.exports = {
    createEmptySession,
    sessionPath,
    loadSession,
    saveSession,
    renameSession,
    forkSession,
    listSessions,
    groupSessionsByDate,
    suggestSessionIdFromPrompt,
    deleteSession,
    cleanupOldSessions,
    loadInputHistory,
    saveInputHistory,
};
