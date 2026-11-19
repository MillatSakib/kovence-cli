"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { safeId, readJsonSafe, atomicWriteJson, resolvePaths } = require("../config/paths");

const MAX_CHECKPOINTS_PER_SESSION = 25;

function checkpointFilePath(sessionId, paths = resolvePaths()) {
    return path.join(paths.checkpointsDir, `${safeId(sessionId)}.json`);
}

function loadCheckpoints(sessionId, paths = resolvePaths()) {
    const data = readJsonSafe(checkpointFilePath(sessionId, paths), { items: [] });
    return Array.isArray(data?.items) ? data.items : [];
}

function saveCheckpoints(sessionId, items, paths = resolvePaths()) {
    fs.mkdirSync(paths.checkpointsDir, { recursive: true });
    atomicWriteJson(checkpointFilePath(sessionId, paths), {
        sessionId: safeId(sessionId),
        updatedAt: new Date().toISOString(),
        items: items.slice(-MAX_CHECKPOINTS_PER_SESSION),
    });
}

/**
 * Snapshot the pre-mutation state of one or more target file paths before modifying/deleting them.
 */
function recordCheckpoint({ sessionId = "default", toolName, filePaths = [], paths = resolvePaths() }) {
    const snapshots = [];
    const seen = new Set();

    for (const raw of filePaths) {
        if (!raw) continue;
        const absPath = path.resolve(raw);
        if (seen.has(absPath)) continue;
        seen.add(absPath);

        if (fs.existsSync(absPath)) {
            const st = fs.statSync(absPath);
            if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
            snapshots.push({
                absPath,
                existed: true,
                contentBase64: fs.readFileSync(absPath).toString("base64"),
            });
        } else {
            snapshots.push({
                absPath,
                existed: false,
                contentBase64: "",
            });
        }
    }

    if (!snapshots.length) return null;
    const list = loadCheckpoints(sessionId, paths);
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        toolName,
        snapshots,
    };
    list.push(entry);
    saveCheckpoints(sessionId, list, paths);
    return entry;
}

/**
 * Restore the latest recorded file checkpoint for the active session (/undo).
 */
function undoLastCheckpoint(sessionId = "default", paths = resolvePaths(), workspaceRoot = process.cwd()) {
    const list = loadCheckpoints(sessionId, paths);
    if (!list.length) return { ok: false, message: "Nothing to undo in this session." };

    const latest = list.pop();
    const restored = [];

    for (const snap of latest.snapshots || []) {
        const rel = path.relative(workspaceRoot, snap.absPath) || snap.absPath;
        if (snap.existed) {
            fs.mkdirSync(path.dirname(snap.absPath), { recursive: true });
            fs.writeFileSync(snap.absPath, Buffer.from(snap.contentBase64, "base64"));
            restored.push(`restored ${rel}`);
        } else {
            if (fs.existsSync(snap.absPath)) {
                fs.rmSync(snap.absPath, { force: true });
            }
            restored.push(`removed created ${rel}`);
        }
    }

    saveCheckpoints(sessionId, list, paths);
    return {
        ok: true,
        toolName: latest.toolName,
        restored,
        remaining: list.length,
        message: `Undid ${latest.toolName}: ${restored.join(", ")} (${list.length} checkpoint(s) remaining)`,
    };
}

module.exports = {
    loadCheckpoints,
    recordCheckpoint,
    undoLastCheckpoint,
};
