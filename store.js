"use strict";

const pathsMod = require("./src/config/paths");
const schemaMod = require("./src/settings/schema");
const settingsMod = require("./src/settings/store");
const providersMod = require("./src/config/providers");
const memoryMod = require("./src/config/memory");
const sessionsMod = require("./src/config/sessions");
const permStoreMod = require("./src/permissions/store");
const permEngineMod = require("./src/permissions/engine");

let defaultPathsCache = null;

function getDefaultPaths(forceRefresh = false) {
    if (!defaultPathsCache || forceRefresh) {
        defaultPathsCache = pathsMod.resolvePaths();
        pathsMod.migrateLegacyAiHarness(defaultPathsCache);
    }
    return defaultPathsCache;
}

module.exports = {
    // Paths & Migration
    get HARNESS_DIR() {
        return getDefaultPaths().projectDir;
    },
    getDefaultPaths,
    resolvePaths: pathsMod.resolvePaths,
    findProjectRoot: pathsMod.findProjectRoot,
    migrateLegacyAiHarness: pathsMod.migrateLegacyAiHarness,
    ensureStorageDirs: pathsMod.ensureStorageDirs,
    safeId: pathsMod.safeId,

    // Settings schema & persistence
    AGENT_MODES: schemaMod.AGENT_MODES,
    TOOL_PERMISSIONS: schemaMod.TOOL_PERMISSIONS,
    NON_WORKSPACE_MODES: schemaMod.NON_WORKSPACE_MODES,
    DEFAULT_SETTINGS: schemaMod.DEFAULT_SETTINGS,
    SETTINGS_SCHEMA: schemaMod.SETTINGS_SCHEMA,
    SCHEMA_BY_KEY: schemaMod.SCHEMA_BY_KEY,
    canonicalSettingKey: schemaMod.canonicalSettingKey,
    parseSettingValue: schemaMod.parseSettingValue,
    stepSettingValue: settingsMod.stepSettingValue,
    resolveEffectiveSettings: settingsMod.resolveEffectiveSettings,
    resolveEffectiveModel: settingsMod.resolveEffectiveModel,
    loadSettings: (paths = getDefaultPaths()) => settingsMod.loadPersistedSettings(paths),
    saveSettings: (settings, paths = getDefaultPaths()) => settingsMod.savePersistedSettings(settings, paths),
    updatePersistedSetting: (key, value, paths = getDefaultPaths()) =>
        settingsMod.updatePersistedSetting(key, value, paths),

    // Providers
    redactSecret: providersMod.redactSecret,
    loadProviders: (envFallback, paths = getDefaultPaths()) => providersMod.loadProviders(envFallback, paths),
    saveProviders: (store, paths = getDefaultPaths()) => providersMod.saveProviders(store, paths),
    upsertProvider: (envFallback, cfg, paths = getDefaultPaths()) =>
        providersMod.upsertProvider(envFallback, cfg, paths),
    addProviderModels: (envFallback, name, models, paths = getDefaultPaths()) =>
        providersMod.addProviderModels(envFallback, name, models, paths),
    setActiveProvider: (envFallback, name, paths = getDefaultPaths()) =>
        providersMod.setActiveProvider(envFallback, name, paths),
    removeProvider: (envFallback, name, paths = getDefaultPaths()) =>
        providersMod.removeProvider(envFallback, name, paths),

    // Memory
    loadGlobalMemory: (paths = getDefaultPaths()) => memoryMod.loadGlobalMemory(paths),
    loadGlobalMemoryEntries: (paths = getDefaultPaths()) => memoryMod.loadGlobalMemoryEntries(paths),
    saveGlobalMemory: (items, paths = getDefaultPaths()) => memoryMod.saveGlobalMemory(items, paths),
    addGlobalMemory: (fact, source = "user", paths = getDefaultPaths()) =>
        memoryMod.addGlobalMemory(fact, source, paths),
    removeGlobalMemoryAt: (idx, paths = getDefaultPaths()) => memoryMod.removeGlobalMemoryAt(idx, paths),
    loadProjectMemoryEntries: (paths = getDefaultPaths()) => memoryMod.loadProjectMemoryEntries(paths),
    saveProjectMemory: (items, paths = getDefaultPaths()) => memoryMod.saveProjectMemory(items, paths),
    addProjectMemory: (fact, source = "user", paths = getDefaultPaths()) =>
        memoryMod.addProjectMemory(fact, source, paths),
    isGlobalMemoryFact: memoryMod.isGlobalMemoryFact,
    classifyMemoryIntent: memoryMod.classifyMemoryIntent,

    // Sessions
    createEmptySession: sessionsMod.createEmptySession,
    loadSession: (id, defaultModel = "", paths = getDefaultPaths()) => sessionsMod.loadSession(id, defaultModel, paths),
    saveSession: (session, paths = getDefaultPaths()) => sessionsMod.saveSession(session, paths),
    renameSession: (session, newId, paths = getDefaultPaths()) => sessionsMod.renameSession(session, newId, paths),
    forkSession: (session, newId, paths = getDefaultPaths()) => sessionsMod.forkSession(session, newId, paths),
    listSessions: (paths = getDefaultPaths()) => sessionsMod.listSessions(paths),
    groupSessionsByDate: sessionsMod.groupSessionsByDate,
    suggestSessionIdFromPrompt: (promptText, paths = getDefaultPaths()) =>
        sessionsMod.suggestSessionIdFromPrompt(promptText, paths),
    loadInputHistory: (paths = getDefaultPaths()) => sessionsMod.loadInputHistory(paths),
    saveInputHistory: (items, paths = getDefaultPaths()) => sessionsMod.saveInputHistory(items, paths),
    deleteSession: (id, paths = getDefaultPaths()) => sessionsMod.deleteSession(id, paths),

    // Permissions
    loadPermissionRules: permStoreMod.loadPermissionRules,
    savePermissionRules: permStoreMod.savePermissionRules,
    addPermissionRule: permStoreMod.addPermissionRule,
    listCombinedRules: permStoreMod.listCombinedRules,
    removePermissionRuleByIndex: permStoreMod.removePermissionRuleByIndex,
    resetPermissionRules: permStoreMod.resetPermissionRules,
    evaluatePermission: permEngineMod.evaluatePermission,
    buildSuggestedRules: permEngineMod.buildSuggestedRules,
    parseShellCommand: permEngineMod.parseShellCommand,
    getSegmentPrefix: permEngineMod.getSegmentPrefix,
    isReadOnlyShellCommand: permEngineMod.isReadOnlyShellCommand,
    isPathInsideWorkspace: permEngineMod.isPathInsideWorkspace,
    checkHardDenylist: permEngineMod.checkHardDenylist,
    isSecretFilePath: permEngineMod.isSecretFilePath,
};
