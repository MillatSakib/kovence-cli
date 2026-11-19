"use strict";

const {
    ensureStorageDirs,
    readJsonSafe,
    atomicWriteJson,
    resolvePaths,
} = require("../config/paths");
const {
    DEFAULT_SETTINGS,
    PERSISTABLE_KEYS,
    SCHEMA_BY_KEY,
    parseSettingValue,
} = require("./schema");

/**
 * Normalize loaded settings object against schema defaults without introducing runtime-only keys.
 */
function sanitizePersistedObject(raw) {
    const out = { ...DEFAULT_SETTINGS };
    if (!raw || typeof raw !== "object") return out;

    // Legacy compatibility: read old autoApprove=true only when agentMode was not explicitly stored.
    if (raw.autoApprove === true && raw.agentMode === undefined) {
        out.agentMode = "auto";
    }

    for (const key of PERSISTABLE_KEYS) {
        if (raw[key] === undefined) continue;
        const parsed = parseSettingValue(key, raw[key]);
        if (parsed.ok) {
            out[key] = parsed.value;
        }
    }
    return out;
}

/**
 * Load persisted settings strictly from settings.json (never includes CLI/session overrides).
 */
function loadPersistedSettings(paths = resolvePaths()) {
    const raw = readJsonSafe(paths.settingsFile, {});
    return sanitizePersistedObject(raw);
}

/**
 * Save strictly persistable fields to settings.json, stripping any runtime overrides or virtual keys.
 */
function savePersistedSettings(settings, paths = resolvePaths()) {
    ensureStorageDirs(paths);
    const clean = sanitizePersistedObject(settings);
    // Explicitly strip legacy autoApprove from disk whenever settings are written.
    const toWrite = {};
    for (const key of PERSISTABLE_KEYS) {
        toWrite[key] = clean[key];
    }
    atomicWriteJson(paths.settingsFile, toWrite);
    return clean;
}

/**
 * Update a single persisted setting cleanly without touching or leaking active runtime overrides.
 */
function updatePersistedSetting(key, rawValue, paths = resolvePaths()) {
    const parsed = parseSettingValue(key, rawValue);
    if (!parsed.ok) return parsed;
    const currentPersisted = loadPersistedSettings(paths);
    currentPersisted[parsed.key] = parsed.value;
    const saved = savePersistedSettings(currentPersisted, paths);
    return {
        ok: true,
        key: parsed.key,
        value: saved[parsed.key],
        settings: saved,
    };
}

/**
 * Cycle an enum or boolean setting to its next/previous value (used by Settings UI Left/Right keys).
 */
function stepSettingValue(key, currentValue, direction = 1) {
    const meta = SCHEMA_BY_KEY.get(key);
    if (!meta) return null;
    if (meta.type === "boolean") return !Boolean(currentValue);
    if (meta.type === "enum" && Array.isArray(meta.options) && meta.options.length > 0) {
        const idx = Math.max(0, meta.options.indexOf(currentValue));
        const nextIdx = (idx + direction + meta.options.length) % meta.options.length;
        return meta.options[nextIdx];
    }
    return null;
}

/**
 * Resolve effective runtime settings by layering CLI flags and session overrides over persisted settings.
 */
function resolveEffectiveSettings(persisted, runtimeOverrides = {}) {
    const base = sanitizePersistedObject(persisted);
    const effective = { ...base };

    if (runtimeOverrides.cliAuto === true) {
        effective.agentMode = "auto";
    }
    if (runtimeOverrides.cliMode) {
        const parsed = parseSettingValue("agentMode", runtimeOverrides.cliMode);
        if (parsed.ok) effective.agentMode = parsed.value;
    }
    if (runtimeOverrides.sessionAgentMode) {
        const parsed = parseSettingValue("agentMode", runtimeOverrides.sessionAgentMode);
        if (parsed.ok) effective.agentMode = parsed.value;
    }
    if (runtimeOverrides.sessionToolPermission) {
        const parsed = parseSettingValue("toolPermission", runtimeOverrides.sessionToolPermission);
        if (parsed.ok) effective.toolPermission = parsed.value;
    }
    if (runtimeOverrides.cliProvider) {
        effective.provider = String(runtimeOverrides.cliProvider).trim();
    }
    return effective;
}

/**
 * Resolve effective model using strict precedence:
 * CLI flag > session model > saved setting > provider default.
 */
function resolveEffectiveModel({
    cliModel = "",
    sessionModel = "",
    persistedModel = "",
    providerDefaultModel = "",
} = {}) {
    for (const candidate of [cliModel, sessionModel, persistedModel, providerDefaultModel]) {
        const clean = String(candidate || "").trim();
        if (clean) return clean;
    }
    return "";
}

module.exports = {
    sanitizePersistedObject,
    loadPersistedSettings,
    savePersistedSettings,
    updatePersistedSetting,
    stepSettingValue,
    resolveEffectiveSettings,
    resolveEffectiveModel,
};
