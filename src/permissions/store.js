"use strict";

const crypto = require("node:crypto");
const { ensureStorageDirs, readJsonSafe, atomicWriteJson, resolvePaths } = require("../config/paths");

const VALID_ACTIONS = new Set(["allow", "deny", "ask"]);
const VALID_SCOPES = new Set(["tool", "commandPrefix", "path", "domain"]);

function makeRuleId() {
    return crypto.randomBytes(4).toString("hex");
}

function normalizeRule(raw) {
    if (!raw || typeof raw !== "object") return null;
    const action = VALID_ACTIONS.has(raw.action) ? raw.action : "allow";
    const scope = VALID_SCOPES.has(raw.scope) ? raw.scope : "tool";
    const tool = String(raw.tool || "").trim();
    const pattern = String(raw.pattern ?? "").trim();
    if (!tool) return null;
    return {
        id: String(raw.id || makeRuleId()),
        action,
        tool,
        scope,
        pattern,
        createdAt: String(raw.createdAt || new Date().toISOString()),
    };
}

function fileForTarget(target, paths = resolvePaths()) {
    return target === "project" ? paths.projectPermissionsFile : paths.globalPermissionsFile;
}

function loadPermissionRules(target = "global", paths = resolvePaths()) {
    const file = fileForTarget(target, paths);
    const data = readJsonSafe(file, { version: 1, rules: [] });
    const rawRules = Array.isArray(data?.rules) ? data.rules : [];
    return rawRules.map(normalizeRule).filter(Boolean);
}

function savePermissionRules(rules, target = "global", paths = resolvePaths()) {
    ensureStorageDirs(paths);
    const clean = (Array.isArray(rules) ? rules : []).map(normalizeRule).filter(Boolean);
    atomicWriteJson(fileForTarget(target, paths), {
        version: 1,
        updatedAt: new Date().toISOString(),
        rules: clean,
    });
    return clean;
}

function addPermissionRule(ruleInput, target = "project", paths = resolvePaths()) {
    const candidate = normalizeRule(ruleInput);
    if (!candidate) throw new Error("Invalid permission rule.");
    const existing = loadPermissionRules(target, paths);
    const idx = existing.findIndex(
        (r) => r.tool === candidate.tool && r.scope === candidate.scope && r.pattern === candidate.pattern
    );
    if (idx >= 0) {
        existing[idx] = { ...candidate, id: existing[idx].id };
    } else {
        existing.push(candidate);
    }
    savePermissionRules(existing, target, paths);
    return candidate;
}

function listCombinedRules(sessionRules = [], paths = resolvePaths()) {
    const project = loadPermissionRules("project", paths).map((r) => ({ ...r, origin: "project" }));
    const global = loadPermissionRules("global", paths).map((r) => ({ ...r, origin: "global" }));
    const session = (Array.isArray(sessionRules) ? sessionRules : [])
        .map(normalizeRule)
        .filter(Boolean)
        .map((r) => ({ ...r, origin: "session" }));
    return [...session, ...project, ...global];
}

function removePermissionRuleByIndex(oneBasedIndex, paths = resolvePaths()) {
    const project = loadPermissionRules("project", paths);
    const global = loadPermissionRules("global", paths);
    const idx = Number(oneBasedIndex) - 1;
    if (!Number.isInteger(idx) || idx < 0) return null;

    if (idx < project.length) {
        const [removed] = project.splice(idx, 1);
        savePermissionRules(project, "project", paths);
        return { ...removed, origin: "project" };
    }
    const gIdx = idx - project.length;
    if (gIdx < global.length) {
        const [removed] = global.splice(gIdx, 1);
        savePermissionRules(global, "global", paths);
        return { ...removed, origin: "global" };
    }
    return null;
}

function resetPermissionRules(target = "all", paths = resolvePaths()) {
    if (target === "all" || target === "project") savePermissionRules([], "project", paths);
    if (target === "all" || target === "global") savePermissionRules([], "global", paths);
}

module.exports = {
    VALID_ACTIONS,
    VALID_SCOPES,
    normalizeRule,
    loadPermissionRules,
    savePermissionRules,
    addPermissionRule,
    listCombinedRules,
    removePermissionRuleByIndex,
    resetPermissionRules,
};
