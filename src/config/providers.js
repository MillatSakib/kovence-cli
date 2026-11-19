"use strict";

const {
    safeId,
    ensureStorageDirs,
    readJsonSafe,
    atomicWriteJson,
    resolvePaths,
} = require("./paths");

/**
 * Redact sensitive API tokens for safe terminal and log display.
 */
function redactSecret(secret) {
    const clean = String(secret || "").trim();
    if (!clean) return "(not set)";
    if (clean.length <= 8) return "***";
    return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

function normalizeModelList(modelsInput, fallbackDefault = "") {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(modelsInput)
        ? modelsInput
        : typeof modelsInput === "string"
          ? modelsInput.split(",")
          : [];
    for (const raw of [...list, fallbackDefault]) {
        const clean = String(raw || "").trim();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        out.push(clean);
    }
    return out;
}

/**
 * Build runtime default provider from environment variables (never persisted to providers.json).
 */
function buildEnvDefaultProvider(envFallback = {}) {
    const baseUrl = String(envFallback.baseUrl || "").replace(/\/+$/, "");
    const apiKey = String(envFallback.apiKey || "").trim();
    if (!baseUrl || !apiKey || apiKey === "sk-your-virtual-key") return null;
    const models = normalizeModelList(envFallback.models, envFallback.defaultModel);
    return {
        name: "default",
        type: envFallback.type === "anthropic" ? "anthropic" : "openai",
        baseUrl,
        apiKey,
        apiKeyEnv: "",
        defaultModel: models[0] || "",
        models,
        fromEnv: true,
    };
}

/**
 * Resolve stored provider entry into runtime view, looking up apiKeyEnv dynamically without mutating persisted keys.
 */
function hydrateCustomProvider(id, raw) {
    if (!raw || typeof raw !== "object" || id === "default") return null;
    const cleanId = safeId(id);
    const type = raw.type === "anthropic" ? "anthropic" : "openai";
    const apiKeyEnv = String(raw.apiKeyEnv || "").trim();
    const storedKey = String(raw.apiKey || "");
    const resolvedKey = apiKeyEnv ? String(process.env[apiKeyEnv] || storedKey || "") : storedKey;
    const models = normalizeModelList(raw.models, raw.defaultModel);
    return {
        name: cleanId,
        type,
        baseUrl: String(raw.baseUrl || "").replace(/\/+$/, ""),
        apiKey: resolvedKey,
        _storedApiKey: storedKey,
        apiKeyEnv,
        defaultModel: String(raw.defaultModel || models[0] || ""),
        models,
        fromEnv: false,
    };
}

/**
 * Load provider profiles, keeping env 'default' dynamic and ignoring any legacy 'default' saved on disk.
 */
function loadProviders(envFallback = {}, paths = resolvePaths()) {
    const envDefault = buildEnvDefaultProvider(envFallback);
    const data = readJsonSafe(paths.providersFile, { active: "", providers: {} });
    const customProviders = {};
    if (data && data.providers && typeof data.providers === "object") {
        for (const [key, val] of Object.entries(data.providers)) {
            if (key === "default") continue;
            const cleanId = safeId(key);
            const hydrated = hydrateCustomProvider(cleanId, val);
            if (hydrated && hydrated.baseUrl) {
                customProviders[cleanId] = hydrated;
            }
        }
    }
    const providers = envDefault ? { default: envDefault, ...customProviders } : { ...customProviders };
    const firstKey = Object.keys(providers)[0] || "";
    const active = data && data.active && providers[data.active] ? data.active : firstKey;
    return { active, providers };
}

/**
 * Persist custom providers only (never writes 'default' or env-resolved plaintext keys when apiKeyEnv is set).
 */
function saveProviders(store, paths = resolvePaths()) {
    ensureStorageDirs(paths);
    const customOnly = {};
    for (const [key, val] of Object.entries(store.providers || {})) {
        if (key === "default" || !val || val.fromEnv) continue;
        const cleanId = safeId(key);
        const apiKeyEnv = String(val.apiKeyEnv || "").trim();
        const storedKey = apiKeyEnv
            ? (val._storedApiKey !== undefined ? String(val._storedApiKey) : "")
            : String(val.apiKey || "");
        const models = normalizeModelList(val.models, val.defaultModel);
        customOnly[cleanId] = {
            name: cleanId,
            type: val.type === "anthropic" ? "anthropic" : "openai",
            baseUrl: String(val.baseUrl || "").replace(/\/+$/, ""),
            ...(apiKeyEnv ? { apiKeyEnv } : {}),
            ...(storedKey ? { apiKey: storedKey } : {}),
            defaultModel: String(val.defaultModel || models[0] || ""),
            ...(models.length ? { models } : {}),
        };
    }
    const firstCustom = Object.keys(customOnly)[0] || "";
    const active = store.active && (store.active === "default" || customOnly[store.active])
        ? store.active
        : firstCustom;
    atomicWriteJson(paths.providersFile, { active, providers: customOnly }, 0o600);
}

function upsertProvider(
    envFallback,
    { name, type, baseUrl, apiKey = "", apiKeyEnv = "", defaultModel = "", models = [] },
    paths = resolvePaths()
) {
    const id = safeId(name);
    if (id === "default") {
        throw new Error("Built-in 'default' provider comes from environment/.env and cannot be overwritten.");
    }
    const store = loadProviders(envFallback, paths);
    const cleanType = type === "anthropic" ? "anthropic" : "openai";
    const cleanEnvVar = String(apiKeyEnv || "").trim();
    const normalizedModels = normalizeModelList(models, defaultModel);
    store.providers[id] = hydrateCustomProvider(id, {
        name: id,
        type: cleanType,
        baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
        apiKey: cleanEnvVar ? "" : String(apiKey || ""),
        apiKeyEnv: cleanEnvVar,
        defaultModel: String(defaultModel || normalizedModels[0] || ""),
        models: normalizedModels,
    });
    if (!store.active || !store.providers[store.active]) store.active = id;
    saveProviders(store, paths);
    return store.providers[id];
}

/**
 * Append one or more individual model names to an existing custom provider without duplicates.
 */
function addProviderModels(envFallback, name, newModels = [], paths = resolvePaths()) {
    const id = safeId(name);
    if (id === "default") {
        throw new Error("Cannot add persisted models to built-in 'default' env provider.");
    }
    const store = loadProviders(envFallback, paths);
    const existing = store.providers[id];
    if (!existing) throw new Error(`Provider '${id}' not found.`);
    const merged = normalizeModelList([...(existing.models || []), ...(Array.isArray(newModels) ? newModels : [newModels])], existing.defaultModel);
    existing.models = merged;
    if (!existing.defaultModel && merged.length) existing.defaultModel = merged[0];
    saveProviders(store, paths);
    return existing;
}

function setActiveProvider(envFallback, name, paths = resolvePaths()) {
    const store = loadProviders(envFallback, paths);
    const id = safeId(name);
    if (!store.providers[id]) throw new Error(`Provider '${id}' not found.`);
    store.active = id;
    saveProviders(store, paths);
    return store.providers[id];
}

function removeProvider(envFallback, name, paths = resolvePaths()) {
    const store = loadProviders(envFallback, paths);
    const id = safeId(name);
    if (id === "default") throw new Error("Cannot remove built-in 'default' provider.");
    if (!store.providers[id]) return false;
    delete store.providers[id];
    if (store.active === id) store.active = Object.keys(store.providers)[0] || "";
    saveProviders(store, paths);
    return true;
}

module.exports = {
    redactSecret,
    normalizeModelList,
    buildEnvDefaultProvider,
    loadProviders,
    saveProviders,
    upsertProvider,
    addProviderModels,
    setActiveProvider,
    removeProvider,
};
