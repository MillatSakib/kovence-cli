"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
    AGENT_MODES,
    loadGlobalMemory,
    saveGlobalMemory,
    addGlobalMemory,
    redactSecret,
    loadProviders,
    upsertProvider,
    addProviderModels,
    setActiveProvider,
    removeProvider,
    loadSession,
    saveSession,
    renameSession,
    forkSession,
    listSessions,
    groupSessionsByDate,
    deleteSession,
    safeId,
    updatePersistedSetting,
    resolveEffectiveModel,
    loadPermissionRules,
    addPermissionRule,
    listCombinedRules,
    removePermissionRuleByIndex,
    resetPermissionRules,
} = require("../../store");
const { listProviderModels } = require("../../providers");
const { TOOL_DEFINITIONS } = require("../../tools");
const { estimateMessagesTokens } = require("../agent/history");
const { estimateTokenCostUsd } = require("../config/model_registry");
const { generateProjectInitDoc } = require("../agent/project_context");
const { undoLastCheckpoint } = require("../tools/checkpoints");
const { getHelpText } = require("../cli/args");

function getEnvFallback() {
    return {
        baseUrl: String(process.env.LITELLM_BASE_URL || "").replace(/\/+$/, ""),
        apiKey: process.env.LITELLM_VIRTUAL_KEY || process.env.LITELLM_API_KEY || "",
        defaultModel: process.env.LITELLM_MODEL || "",
    };
}

function summarizeArgsShort(rawArgs) {
    try {
        const obj = JSON.parse(rawArgs || "{}");
        const first = obj.path || obj.command || obj.query || obj.pattern || obj.url || obj.fact || "";
        return first ? String(first).slice(0, 60) : "";
    } catch {
        return "";
    }
}

function formatContextMessages(state) {
    const msgs = [{ role: "system", content: state.settings.systemPrompt }];
    const g = loadGlobalMemory(state.paths);
    if (g.length) {
        msgs.push({ role: "system", content: g.join("\n") });
    }
    return [...msgs, ...state.session.history.slice(-state.settings.maxHistoryMessages)];
}

function getContextLabel(state) {
    const est = estimateMessagesTokens(formatContextMessages(state));
    const win = state.settings.contextWindow || 128000;
    return `Context: ~${est} / ${win} tokens`;
}

function persistAndApplySetting(state, key, value, sink) {
    const res = updatePersistedSetting(key, value, state.paths);
    if (!res.ok) {
        sink.log("error", res.error);
        return false;
    }
    // Apply changed key onto persisted & active runtime settings without leaking unrelated runtime flags
    state.persistedSettings = res.settings;
    state.settings[res.key] = res.value;
    if (res.key === "agentMode") {
        if (state.runtimeOverrides) {
            delete state.runtimeOverrides.cliAuto;
            delete state.runtimeOverrides.cliMode;
            delete state.runtimeOverrides.sessionAgentMode;
        }
        if (state.session) {
            state.session.agentMode = res.value;
            if (!state.noSession) saveSession(state.session, state.paths);
        }
    }
    if (res.key === "model") {
        state.model = res.value || state.provider?.defaultModel || state.model;
        if (state.cliModel) state.cliModel = state.model;
        if (state.session) {
            state.session.model = state.model;
            if (!state.noSession) saveSession(state.session, state.paths);
        }
    }
    if (res.key === "provider") {
        const store = loadProviders(getEnvFallback(), state.paths);
        if (store.providers[res.value]) {
            setActiveProvider(getEnvFallback(), res.value, state.paths);
            state.provider = store.providers[res.value];
            state.cliModel = "";
            const provModels = Array.isArray(state.provider.models) ? state.provider.models : [];
            const currentValid = state.model && provModels.includes(state.model);
            const nextModel = currentValid ? state.model : state.provider.defaultModel || provModels[0] || state.model;
            if (nextModel) {
                state.model = nextModel;
                if (state.session) {
                    state.session.model = nextModel;
                    if (!state.noSession) saveSession(state.session, state.paths);
                }
                updatePersistedSetting("model", nextModel, state.paths);
                state.persistedSettings.model = nextModel;
            }
        }
    }
    sink.syncStatus();
    return true;
}

function handleSetCommand(state, arg, sink) {
    const [key, ...rest] = arg.split(/\s+/);
    const val = rest.join(" ").trim();
    if (!key) {
        const safeSettings = { ...state.persistedSettings };
        sink.log("system", JSON.stringify(safeSettings, null, 2));
        return;
    }
    if (!val) {
        sink.log("error", `Usage: /set ${key} <value>`);
        return;
    }
    if (persistAndApplySetting(state, key, val, sink)) {
        sink.log("system", `Updated ${key}: ${JSON.stringify(state.settings[key])}`);
    }
}

async function handleModeCommand(state, arg, sink) {
    let clean = arg.trim().toLowerCase();
    if (!clean) {
        if (sink.openModePicker) {
            const chosen = await sink.openModePicker(state.settings.agentMode);
            if (!chosen) return;
            clean = chosen;
        } else {
            sink.log("system", `Current agentMode: ${state.settings.agentMode} (valid: ${AGENT_MODES.join(", ")})`);
            return;
        }
    }
    if (!AGENT_MODES.includes(clean)) {
        sink.log("error", `Invalid mode '${clean}'. Choose one of: ${AGENT_MODES.join(", ")}`);
        return;
    }
    if (persistAndApplySetting(state, "agentMode", clean, sink)) {
        state.session.agentMode = clean;
        if (!state.noSession) saveSession(state.session, state.paths);
        sink.syncStatus();
        sink.log("system", `Agent mode switched to '${clean}'.`);
    }
}

function inferPermissionScope(tool, pattern) {
    if (!pattern || pattern === "*") return { scope: "tool", pattern: "" };
    if (tool === "run_command") return { scope: "commandPrefix", pattern };
    if (tool === "web_fetch" || tool === "download_file") return { scope: "domain", pattern };
    return { scope: "path", pattern };
}

function handlePermissionsCommand(state, arg, sink) {
    if (!arg.trim() && sink.openPermissions) {
        sink.openPermissions();
        return;
    }
    const parts = arg.split(/\s+/).filter(Boolean);
    const isGlobal = parts.includes("--global");
    const cleanParts = parts.filter((p) => p !== "--global");
    const sub = (cleanParts[0] || "list").toLowerCase();

    if (sub === "list") {
        const all = listCombinedRules(state.sessionRules, state.paths);
        if (!all.length) {
            sink.log(
                "system",
                "(No permission rules configured. Use /permissions allow|deny or approve with [s]/[A].)"
            );
            return;
        }
        const lines = all.map(
            (r, i) => `${i + 1}. [${r.origin}] ${r.action.toUpperCase()} ${r.tool} (${r.scope}: ${r.pattern || "*"})`
        );
        sink.log("system", `Permission Rules:\n${lines.join("\n")}`);
        return;
    }

    if ((sub === "allow" || sub === "deny") && cleanParts[1]) {
        const tool = cleanParts[1];
        const rawPattern = cleanParts.slice(2).join(" ").trim();
        const { scope, pattern } = inferPermissionScope(tool, rawPattern);
        const target = isGlobal ? "global" : "project";
        const saved = addPermissionRule({ action: sub, tool, scope, pattern }, target, state.paths);
        sink.log(
            "system",
            `Added ${target} ${saved.action} rule: ${saved.tool} (${saved.scope}: ${saved.pattern || "*"})`
        );
        return;
    }

    if (sub === "rm" && cleanParts[1]) {
        const n = Number(cleanParts[1]);
        if (!Number.isInteger(n) || n < 1) {
            sink.log("error", "Usage: /permissions rm <rule-number>");
            return;
        }
        const sessionLen = state.sessionRules.length;
        if (n <= sessionLen) {
            const [removed] = state.sessionRules.splice(n - 1, 1);
            sink.log("system", `Removed session rule: ${removed.tool} (${removed.pattern || "*"})`);
            return;
        }
        const removed = removePermissionRuleByIndex(n - sessionLen, state.paths);
        sink.log(
            removed ? "system" : "error",
            removed
                ? `Removed ${removed.origin} rule: ${removed.tool} (${removed.pattern || "*"})`
                : `Rule #${n} not found.`
        );
        return;
    }

    if (sub === "reset") {
        state.sessionRules = [];
        const scope = cleanParts[1] === "global" || cleanParts[1] === "project" ? cleanParts[1] : "all";
        resetPermissionRules(scope, state.paths);
        sink.log("system", `Reset permission rules (${scope}).`);
        return;
    }

    sink.log(
        "system",
        "Usage: /permissions [list | allow <tool> [pattern] [--global] | deny <tool> [pattern] [--global] | rm <n> | reset]"
    );
}

async function promptMoreModels(initialModels, providerName, sink) {
    const models = [...initialModels.filter(Boolean)];
    if (!sink.askPrompt) return models;

    if (models.length === 0) {
        const first = (await sink.askPrompt(`Model #1 name for '${providerName}' (required): `)).trim();
        if (first) models.push(first);
    }
    while (models.length > 0) {
        const latest = models[models.length - 1];
        const ans = (
            await sink.askPrompt(
                `Added '${latest}' (total ${models.length}). Add more model? [y=add more / Enter or n=finish]: `
            )
        ).trim();
        const low = ans.toLowerCase();
        if (!ans || low === "n" || low === "no") break;
        if (low === "y" || low === "yes") {
            const nextModel = (await sink.askPrompt(`Model #${models.length + 1} name: `)).trim();
            if (nextModel && !models.includes(nextModel)) models.push(nextModel);
            continue;
        }
        // User typed a model name directly at the prompt
        if (!models.includes(ans)) models.push(ans);
    }
    return models;
}

async function runAddModelWizard(state, targetProviderName, initialModels, sink, envFallback) {
    const store = loadProviders(envFallback, state.paths);
    let provName = targetProviderName;
    if (!provName) {
        const customProvs = Object.values(store.providers).filter((p) => !p.fromEnv);
        if (!customProvs.length) {
            sink.log("error", "No custom provider found. Use /api -> + Add Custom Provider first.");
            return;
        }
        if (customProvs.length === 1) {
            provName = customProvs[0].name;
        } else if (sink.openChoicePicker) {
            const items = customProvs.map((p) => ({
                type: "provider",
                id: p.name,
                label: `${p.name === store.active ? "● " : "  "}${p.name}`,
                desc: `${(p.models || []).length} model(s) · ${p.baseUrl}`,
            }));
            provName = await sink.openChoicePicker("Add Models to Which Provider?", items, store.active);
            if (!provName) return;
        } else if (sink.askPrompt) {
            provName = (await sink.askPrompt("Custom provider name: ")).trim();
        }
    }
    if (!provName) return;

    const toAdd = initialModels.length ? initialModels : await promptMoreModels([], provName, sink);
    if (!toAdd.length) {
        sink.log("system", "No models added.");
        return;
    }
    const updated = addProviderModels(envFallback, provName, toAdd, state.paths);
    if (state.provider?.name === updated.name) {
        state.provider = updated;
        if (!state.model && updated.defaultModel) {
            state.model = updated.defaultModel;
            state.session.model = updated.defaultModel;
        }
    }
    sink.syncStatus();
    sink.log("system", `Updated '${updated.name}' models (${updated.models.length}): ${updated.models.join(", ")}`);
}

async function handleApiCommand(state, arg, sink) {
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = parts[0] || "";
    const envFallback = getEnvFallback();

    if (!sub) {
        const store = loadProviders(envFallback, state.paths);
        if (sink.openChoicePicker) {
            const customCount = Object.values(store.providers).filter((p) => !p.fromEnv).length;
            const items = [
                {
                    type: "new",
                    id: "__add_provider__",
                    label: "+ Add Custom Provider",
                    desc: "Add any OpenAI/Anthropic API + multiple individual models",
                },
                ...(customCount > 0
                    ? [
                          {
                              type: "new",
                              id: "__add_models__",
                              label: "+ Add More Model",
                              desc: "Add more model names to an existing custom provider",
                          },
                      ]
                    : []),
                ...Object.values(store.providers).map((p) => {
                    const mCount = Array.isArray(p.models) ? p.models.length : p.defaultModel ? 1 : 0;
                    return {
                        type: "provider",
                        id: p.name,
                        label: `${p.name === store.active ? "● " : "  "}${p.name}`,
                        desc: `[${p.type}] ${p.baseUrl}${mCount ? ` · ${mCount} model(s)` : ""}`,
                    };
                }),
            ];
            const chosen = await sink.openChoicePicker("API Providers (/api)", items, store.active);
            if (!chosen) return;
            if (chosen === "__add_provider__") {
                parts[0] = "add";
            } else if (chosen === "__add_models__") {
                await runAddModelWizard(
                    state,
                    !state.provider.fromEnv ? state.provider.name : "",
                    [],
                    sink,
                    envFallback
                );
                return;
            } else {
                parts[0] = "use";
                parts[1] = chosen;
            }
        } else {
            const lines = Object.values(store.providers).map((p) => {
                const mark = p.name === store.active ? "* " : "  ";
                const keyInfo = p.apiKeyEnv ? `env:${p.apiKeyEnv}` : `key:${redactSecret(p.apiKey)}`;
                const mods =
                    Array.isArray(p.models) && p.models.length ? p.models.join(", ") : p.defaultModel || "auto";
                return `${mark}${p.name} [${p.type}] -> ${p.baseUrl} (${keyInfo}) · models: ${mods}`;
            });
            sink.log("system", `Configured API Providers:\n${lines.join("\n")}`);
            return;
        }
    }

    const action = parts[0] || "list";

    if (action === "list") {
        const store = loadProviders(envFallback, state.paths);
        const lines = Object.values(store.providers).map((p) => {
            const mark = p.name === store.active ? "* " : "  ";
            const keyInfo = p.apiKeyEnv ? `env:${p.apiKeyEnv}` : `key:${redactSecret(p.apiKey)}`;
            const mods = Array.isArray(p.models) && p.models.length ? p.models.join(", ") : p.defaultModel || "auto";
            return `${mark}${p.name} [${p.type}] -> ${p.baseUrl} (${keyInfo}) · models: ${mods}`;
        });
        sink.log("system", `Configured API Providers:\n${lines.join("\n")}`);
        return;
    }

    if (action === "add-model") {
        const provTarget = parts[1] || (!state.provider.fromEnv ? state.provider.name : "");
        const cliModels = parts
            .slice(2)
            .join(" ")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        await runAddModelWizard(state, provTarget, cliModels, sink, envFallback);
        return;
    }

    if (action === "add") {
        let [, name, type, baseUrl, apiKey, defaultModelArg] = parts;
        let models = defaultModelArg
            ? defaultModelArg
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
            : [];
        const interactiveAdd = !name || !type || !baseUrl || !apiKey;

        if (interactiveAdd) {
            if (!sink.askPrompt) {
                sink.log("error", "Usage: /api add <name> <openai|anthropic> <base_url> <api_key> <model1,model2,...>");
                return;
            }
            name = name || (await sink.askPrompt("Custom provider name (e.g. openrouter, groq, claude): ")).trim();
            if (!name) {
                sink.log("system", "Cancelled adding provider.");
                return;
            }
            const rawType = type || (await sink.askPrompt("API Type [openai / anthropic] (default: openai): ")).trim();
            type = rawType || "openai";
            baseUrl = baseUrl || (await sink.askPrompt("Base URL (e.g. https://api.openai.com/v1): ")).trim();
            apiKey = apiKey || (await (sink.askPassword || sink.askPrompt)("API Key (or ENV:VAR_NAME): ")).trim();
            models = await promptMoreModels(models, name, sink);
        }

        if (!name || !baseUrl || !apiKey) {
            sink.log("error", "Cancelled: name, base_url, and api_key are required.");
            return;
        }
        if (!models.length && sink.askPrompt) {
            models = await promptMoreModels([], name, sink);
        }
        if (!models.length) {
            sink.log("error", "Cancelled: at least one model name is required.");
            return;
        }

        const apiKeyEnv = apiKey.startsWith("ENV:") ? apiKey.slice(4).trim() : "";
        const saved = upsertProvider(
            envFallback,
            {
                name,
                type: String(type || "openai").toLowerCase(),
                baseUrl,
                apiKey: apiKeyEnv ? "" : apiKey,
                apiKeyEnv,
                defaultModel: models[0] || "",
                models,
            },
            state.paths
        );
        setActiveProvider(envFallback, saved.name, state.paths);
        state.provider = saved;
        persistAndApplySetting(state, "provider", saved.name, sink);
        if (saved.defaultModel) {
            state.model = saved.defaultModel;
            state.session.model = saved.defaultModel;
            updatePersistedSetting("model", saved.defaultModel, state.paths);
            if (!state.noSession) saveSession(state.session, state.paths);
        }
        sink.syncStatus();
        sink.log(
            "system",
            `Added & switched to '${saved.name}' (${saved.type}: ${saved.baseUrl}) with ${saved.models.length} model(s): ${saved.models.join(", ")}`
        );
        return;
    }

    if (action === "use") {
        let targetName = parts[1] || "";
        if (!targetName && sink.openChoicePicker) {
            const store = loadProviders(envFallback, state.paths);
            const items = Object.values(store.providers).map((p) => ({
                type: "provider",
                id: p.name,
                label: `${p.name === store.active ? "● " : "  "}${p.name}`,
                desc: `[${p.type}] ${p.baseUrl}`,
            }));
            targetName = await sink.openChoicePicker("Switch API Provider", items, store.active);
            if (!targetName) return;
        }
        if (!targetName) {
            sink.log("error", "Usage: /api use <provider-name>");
            return;
        }
        const active = setActiveProvider(envFallback, targetName, state.paths);
        state.provider = active;
        updatePersistedSetting("provider", active.name, state.paths);
        if (active.defaultModel) {
            state.model = active.defaultModel;
            state.session.model = active.defaultModel;
            updatePersistedSetting("model", active.defaultModel, state.paths);
        } else {
            state.model = resolveEffectiveModel({
                cliModel: state.cliModel,
                sessionModel: state.session.model,
                persistedModel: state.persistedSettings.model,
                providerDefaultModel: active.defaultModel,
            });
        }
        if (!state.noSession) saveSession(state.session, state.paths);
        sink.syncStatus();
        sink.log(
            "system",
            `Switched active API to '${active.name}' (${active.type}: ${active.baseUrl}, model: ${state.model || "auto"})`
        );
        return;
    }

    if (action === "rm" && parts[1]) {
        const removed = removeProvider(envFallback, parts[1], state.paths);
        const store = loadProviders(envFallback, state.paths);
        state.provider = store.providers[store.active];
        sink.syncStatus();
        sink.log(
            "system",
            removed
                ? `Removed provider '${parts[1]}'. Active: '${state.provider.name}'`
                : `Provider '${parts[1]}' not found.`
        );
        return;
    }

    sink.log(
        "system",
        "Usage: /api [list | add <name> <openai|anthropic> <url> <key> [model] | use <name> | rm <name>]"
    );
}

function replaySessionHistory(sink, state) {
    if (!sink.isTui) return;
    if (state.session.summaryMemory) {
        sink.log("meta", `Memory Summary: ${state.session.summaryMemory.replace(/\s+/g, " ").slice(0, 140)}`);
    }
    for (const m of state.session.history.slice(-20)) {
        if (m.role === "user") sink.log("user", m.content || "");
        else if (m.role === "assistant" && m.content) sink.log("assistant", m.content);
        else if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            for (const tc of m.tool_calls) {
                sink.log("tool", `⚙ ${tc.function?.name || "tool"}(${summarizeArgsShort(tc.function?.arguments)})`);
            }
        }
    }
}

async function switchToSession(state, targetId, isNew, sink, waitForMemorySync) {
    state.activePrompt = "";
    if (Array.isArray(state.queue)) state.queue.length = 0;
    state.activeAbort?.abort();
    state.memoryAbort?.abort();
    await waitForMemorySync?.(state);
    if (!state.noSession) saveSession(state.session, state.paths);
    const cleanId = safeId(targetId || (isNew ? `session-${Date.now()}` : "default"));
    state.session = loadSession(cleanId, state.model, state.paths);
    if (isNew) {
        state.session.summaryMemory = "";
        state.session.pinnedMemory = [];
        state.session.todos = [];
        state.session.history = [];
        state.session.agentMode = null;
        state.sudoPasswords.delete(state.session.id);
        if (!state.noSession) saveSession(state.session, state.paths);
    }
    if (!state.runtimeOverrides?.cliMode && !state.runtimeOverrides?.cliAuto) {
        state.settings.agentMode = state.session.agentMode || state.persistedSettings.agentMode;
    }
    state.model = resolveEffectiveModel({
        cliModel: state.cliModel,
        sessionModel: state.session.model,
        persistedModel: state.persistedSettings.model,
        providerDefaultModel: state.provider.defaultModel,
    });
    sink.clear();
    sink.syncStatus();
    replaySessionHistory(sink, state);
    if (!sink.isTui) {
        sink.log(
            "system",
            `Active session: ${state.session.id} (${state.session.history.length} msgs, summary: ${state.session.summaryMemory ? "yes" : "no"})`
        );
    }
}

async function openSessionPicker(state, tui, sink, waitForMemorySync) {
    while (true) {
        const list = listSessions(state.paths);
        const groups = groupSessionsByDate(list);
        const items = [{ type: "new", id: "", label: "+ New Session", desc: "Start a fresh isolated session" }];
        for (const g of groups) {
            items.push({
                type: "header",
                id: `__date_${g.dateKey}`,
                label: g.dateLabel,
                desc: `${g.sessions.length} session(s)`,
            });
            for (const s of g.sessions) {
                const activeMark = s.id === state.session.id ? "● " : "  ";
                const prev = s.preview ? ` · "${s.preview}"` : "";
                items.push({
                    type: "session",
                    id: s.id,
                    label: `${activeMark}${s.id}`,
                    desc: `${s.messages} msgs${s.hasSummary ? " · mem" : ""}${prev}`,
                });
            }
        }
        const res = await tui.openPicker("Sessions (Ctrl+S)", items);
        if (!res) return;
        if (res.action === "delete" && res.item?.type === "session") {
            if (res.item.id === state.session.id) {
                sink.log("error", "Cannot delete active session. Switch first.");
                return;
            }
            state.sudoPasswords.delete(res.item.id);
            deleteSession(res.item.id, state.paths);
            continue;
        }
        if (res.action === "select") {
            if (res.item.type === "new") {
                const rawName = (await tui.askModal("New session name (blank = auto): ", false)).trim();
                const id = rawName || `session-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
                await switchToSession(state, id, true, sink, waitForMemorySync);
                return;
            }
            await switchToSession(state, res.item.id, false, sink, waitForMemorySync);
            return;
        }
        return;
    }
}

async function handleMemoryCommand(state, arg, sink) {
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = parts[0] || "show";

    if (sub === "global") {
        const gsub = parts[1] || "show";
        const gtext = parts.slice(2).join(" ");
        const items = loadGlobalMemory(state.paths);
        if (gsub === "add" && gtext) {
            addGlobalMemory(gtext, "user", state.paths);
            sink.log("system", "Added to Default Global Memory.");
        } else if (gsub === "rm" && parts[2]) {
            const idx = Number(parts[2]) - 1;
            if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
                sink.log("error", `Invalid global memory index '${parts[2]}'.`);
                return;
            }
            const next = items.filter((_, i) => i !== idx);
            saveGlobalMemory(next, state.paths);
            sink.log("system", `Global memory now has ${next.length} items.`);
        } else if (gsub === "clear") {
            saveGlobalMemory([], state.paths);
            sink.log("system", "Global memory cleared.");
        } else {
            sink.log(
                "system",
                items.length ? items.map((x, i) => `${i + 1}. ${x}`).join("\n") : "(empty global memory)"
            );
        }
        return;
    }

    if (sub === "add" && parts.length > 1) {
        state.session.pinnedMemory.push(parts.slice(1).join(" "));
        if (!state.noSession) saveSession(state.session, state.paths);
        sink.log("system", `Added to session '${state.session.id}' local memory.`);
        return;
    }
    if (sub === "clear") {
        state.session.summaryMemory = "";
        state.session.pinnedMemory = [];
        if (!state.noSession) saveSession(state.session, state.paths);
        sink.log("system", `Session '${state.session.id}' memory cleared.`);
        return;
    }

    const gItems = loadGlobalMemory(state.paths);
    sink.log(
        "system",
        `Session '${state.session.id}' Summary Memory:\n${state.session.summaryMemory || "(none yet)"}\n\n` +
            `Session Local Pinned Memory:\n${state.session.pinnedMemory.length ? state.session.pinnedMemory.map((x) => `- ${x}`).join("\n") : "(none)"}\n\n` +
            `Global Default Memory (ALL sessions):\n${gItems.length ? gItems.map((x, i) => `${i + 1}. ${x}`).join("\n") : "(none)"}`
    );
}

async function runModelProviderBrowser(state, sink) {
    const envFallback = getEnvFallback();
    while (true) {
        const store = loadProviders(envFallback, state.paths);
        const customProvs = Object.values(store.providers).filter((p) => !p.fromEnv);

        const provItems = [
            ...Object.values(store.providers).map((p) => {
                const mCount = Array.isArray(p.models) ? p.models.length : p.defaultModel ? 1 : 0;
                return {
                    type: "provider",
                    id: p.name,
                    label: `${p.name === store.active ? "● " : "  "}${p.name}`,
                    desc: `[${p.type}] ${p.baseUrl}${mCount ? ` · ${mCount} saved model(s)` : ""}`,
                };
            }),
            {
                type: "new",
                id: "__add_provider__",
                label: "+ Add Custom Provider",
                desc: "Add new OpenAI/Anthropic API + individual models",
            },
            ...(customProvs.length > 0
                ? [
                      {
                          type: "action",
                          id: "__remove_provider__",
                          label: "✖ Remove Provider",
                          desc: "Delete a saved custom API provider",
                      },
                  ]
                : []),
        ];

        const chosenProvId = await sink.openChoicePicker("Select Provider -> Models", provItems, store.active);
        if (!chosenProvId) return;

        if (chosenProvId === "__add_provider__") {
            await handleApiCommand(state, "add", sink);
            continue;
        }

        if (chosenProvId === "__remove_provider__") {
            const rmItems = customProvs.map((p) => ({
                type: "provider",
                id: p.name,
                label: `  ${p.name}`,
                desc: `[${p.type}] ${p.baseUrl}`,
            }));
            const rmTarget = await sink.openChoicePicker("Remove Custom Provider", rmItems, "");
            if (rmTarget) {
                removeProvider(envFallback, rmTarget, state.paths);
                const afterStore = loadProviders(envFallback, state.paths);
                state.provider = afterStore.providers[afterStore.active];
                state.model = resolveEffectiveModel({
                    cliModel: state.cliModel,
                    sessionModel: state.session.model,
                    persistedModel: state.persistedSettings.model,
                    providerDefaultModel: state.provider.defaultModel,
                });
                sink.syncStatus();
                sink.log("system", `Removed provider '${rmTarget}'. Active: '${state.provider.name}'`);
            }
            continue;
        }

        const selectedProv = store.providers[chosenProvId];
        if (!selectedProv) continue;

        // Level 2: Show models for selected provider (+ Add More Model at bottom)
        while (true) {
            const freshStore = loadProviders(envFallback, state.paths);
            const prov = freshStore.providers[chosenProvId] || selectedProv;
            let remoteIds = [];
            try {
                remoteIds = await listProviderModels(prov);
            } catch {}

            const merged = Array.from(
                new Set([...(Array.isArray(prov.models) ? prov.models : []), ...remoteIds])
            ).filter(Boolean);

            const modelItems = [
                ...merged.map((id) => {
                    const isCurrent = prov.name === state.provider.name && id === state.model;
                    return {
                        type: "model",
                        id,
                        label: `${isCurrent ? "● " : "  "}${id}`,
                        desc: isCurrent ? "active" : "",
                    };
                }),
                ...(!prov.fromEnv
                    ? [
                          {
                              type: "new",
                              id: "__add_more_model__",
                              label: "+ Add More Model",
                              desc: `Add model(s) to '${prov.name}'`,
                          },
                      ]
                    : []),
                {
                    type: "action",
                    id: "__back__",
                    label: "← Back to Providers",
                    desc: "Choose another provider",
                },
            ];

            const activeHint = prov.name === state.provider.name ? state.model : prov.defaultModel || "";
            const chosenModel = await sink.openChoicePicker(`Models (${prov.name})`, modelItems, activeHint);
            if (!chosenModel) return;
            if (chosenModel === "__back__") break;
            if (chosenModel === "__add_more_model__") {
                await runAddModelWizard(state, prov.name, [], sink, envFallback);
                continue;
            }

            // Apply chosen provider + model cleanly
            if (prov.name !== state.provider.name) {
                const active = setActiveProvider(envFallback, prov.name, state.paths);
                state.provider = active;
                updatePersistedSetting("provider", active.name, state.paths);
            }
            state.model = chosenModel;
            state.session.model = chosenModel;
            updatePersistedSetting("model", chosenModel, state.paths);
            state.persistedSettings.model = chosenModel;
            if (!state.noSession) saveSession(state.session, state.paths);
            sink.syncStatus();
            sink.log("system", `Switched to ${state.provider.name} · model: ${state.model}`);
            return;
        }
    }
}

async function handleSlash(state, input, sink, deps) {
    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
        case "/help":
            sink.log("system", getHelpText());
            return;
        case "/mode":
            await handleModeCommand(state, arg, sink);
            return;
        case "/api":
            await handleApiCommand(state, arg, sink);
            return;
        case "/settings":
            if (sink.openSettings) sink.openSettings();
            else sink.log("system", JSON.stringify(state.persistedSettings, null, 2));
            return;
        case "/set":
            handleSetCommand(state, arg, sink);
            return;
        case "/session":
        case "/sessions": {
            const parts = arg.split(/\s+/).filter(Boolean);
            const sub = parts[0] || "";
            const name = parts.slice(1).join(" ").trim();
            if (!sub && sink.openSessions) {
                await sink.openSessions();
                return;
            }
            if (!sub || sub === "list") {
                const list = listSessions(state.paths);
                if (!list.length) {
                    sink.log("system", "No saved sessions.");
                    return;
                }
                const groups = groupSessionsByDate(list);
                const lines = [];
                for (const g of groups) {
                    lines.push(`${g.dateLabel} (${g.sessions.length})`);
                    for (const s of g.sessions) {
                        lines.push(
                            `  ${s.id === state.session.id ? "* " : "  "}${s.id} (${s.messages} msgs${s.hasSummary ? ", mem" : ""})${s.preview ? ` - "${s.preview}"` : ""}`
                        );
                    }
                }
                sink.log("system", lines.join("\n"));
                return;
            }
            if (sub === "new" || sub === "switch" || sub === "load") {
                const isNew = sub === "new";
                const targetId = isNew ? name || `session-${Date.now()}` : name || "default";
                await switchToSession(state, targetId, isNew, sink, deps.waitForMemorySync);
                return;
            }
            if (sub === "delete" && name) {
                const clean = safeId(name);
                if (clean === state.session.id) {
                    sink.log("error", "Cannot delete currently active session. Switch first.");
                    return;
                }
                state.sudoPasswords.delete(clean);
                sink.log(
                    "system",
                    deleteSession(clean, state.paths) ? `Deleted session '${clean}'.` : `Session '${clean}' not found.`
                );
                return;
            }
            sink.log("system", "Usage: /session [list|new <name>|switch <name>|delete <name>]");
            return;
        }
        case "/new": {
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
            const nextId = arg || `session-${stamp}-${Math.random().toString(36).slice(2, 5)}`;
            await switchToSession(state, nextId, true, sink, deps.waitForMemorySync);
            return;
        }
        case "/rename": {
            if (!arg) {
                sink.log("error", "Usage: /rename <session-name>");
                return;
            }
            const nextId = renameSession(state.session, arg, state.paths);
            state.noSession = false;
            sink.syncStatus();
            sink.log("system", `Session renamed & saved as '${nextId}'.`);
            return;
        }
        case "/fork": {
            const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
            const forkId = arg || `${state.session.id}-fork-${stamp}`;
            const forked = forkSession(state.session, forkId, state.paths);
            state.session = forked;
            state.noSession = false;
            sink.syncStatus();
            sink.log("system", `Forked into new session '${forked.id}' (${forked.history.length} msgs).`);
            return;
        }
        case "/export": {
            const parts = arg.split(/\s+/).filter(Boolean);
            let fmt = "md";
            let outArg = "";
            if (parts[0] === "json" || parts[0] === "md") {
                fmt = parts[0];
                outArg = parts[1] || "";
            } else if (parts[0]) {
                outArg = parts[0];
                if (outArg.endsWith(".json")) fmt = "json";
            }
            const root = state.workspaceRoot || process.cwd();
            const defaultName = `${safeId(state.session.id)}.${fmt}`;
            const targetPath = path.resolve(root, outArg || defaultName);
            let content = "";
            if (fmt === "json") {
                content = JSON.stringify(state.session, null, 2);
            } else {
                const lines = [
                    `# Kovence Session: ${state.session.id}`,
                    `- Model: ${state.model} · Mode: ${state.settings?.agentMode || "default"}`,
                    state.session.title ? `- Title: ${state.session.title}` : "",
                    "",
                    ...state.session.history.map((m) => {
                        const hdr = `## ${String(m.role || "unknown").toUpperCase()}`;
                        const body = m.content
                            ? String(m.content)
                            : `[tool_calls: ${JSON.stringify(m.tool_calls || [])}]`;
                        return `${hdr}\n\n${body}\n`;
                    }),
                ].filter((l) => l !== "");
                content = lines.join("\n");
            }
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, content, "utf8");
            sink.log("system", `Exported session (${fmt}) -> ${path.relative(root, targetPath) || targetPath}`);
            return;
        }
        case "/edit-last": {
            const hist = state.session.history || [];
            const lastUserIdx = hist.findLastIndex((m) => m.role === "user");
            if (lastUserIdx < 0) {
                sink.log("system", "No user turn found to edit.");
                return;
            }
            const rawContent = String(hist[lastUserIdx].content || "");
            const promptOnly = rawContent.split(/\n\n--- File: /)[0];
            state.session.history = hist.slice(0, lastUserIdx);
            if (!state.noSession) saveSession(state.session, state.paths);
            sink.syncStatus();
            if (sink.setInput) {
                sink.setInput(promptOnly);
                sink.log("system", "Removed last turn and restored prompt to input box for editing.");
            } else {
                sink.log("system", `Removed last turn. Prompt was:\n${promptOnly}`);
            }
            return;
        }
        case "/cost": {
            const pTok = state.session?.stats?.promptTokens || 0;
            const cTok = state.session?.stats?.completionTokens || 0;
            const est = estimateTokenCostUsd(state.model, pTok, cTok);
            const costLine = est.knownPricing
                ? `Estimated Cost: $${est.totalUsd.toFixed(6)} (in: $${est.inCost.toFixed(6)}, out: $${est.outCost.toFixed(6)})`
                : `Estimated Cost: unknown pricing for '${state.model}' (tokens: ${pTok} in, ${cTok} out)`;
            sink.log(
                "system",
                `${costLine}\nRequests: ${state.session?.stats?.requests || 0} · Tokens: ${pTok} in, ${cTok} out`
            );
            return;
        }
        case "/save": {
            if (arg) {
                const nextId = renameSession(state.session, arg, state.paths);
                state.noSession = false;
                sink.syncStatus();
                sink.log("system", `Session renamed & saved as '${nextId}'.`);
            } else if (state.noSession) {
                sink.log("system", "Running in --no-session mode. Use /save <name> to save this session.");
            } else {
                saveSession(state.session, state.paths);
                sink.syncStatus();
                sink.log("system", `Saved session: ${state.session.id}`);
            }
            return;
        }
        case "/undo": {
            const res = undoLastCheckpoint(state.session.id, state.paths, state.workspaceRoot);
            sink.log(res.ok ? "system" : "meta", res.message);
            return;
        }
        case "/init": {
            const fs = require("node:fs");
            const path = require("node:path");
            const root = state.workspaceRoot || process.cwd();
            const target = path.join(root, "KOVENCE.md");
            if (fs.existsSync(target) && sink.confirm) {
                const ans = (await sink.confirm("KOVENCE.md already exists. Overwrite? [y/n]: ")).trim().toLowerCase();
                if (ans !== "y" && ans !== "yes") {
                    sink.log("system", "Skipped /init (kept existing KOVENCE.md).");
                    return;
                }
            }
            const doc = generateProjectInitDoc(root);
            fs.writeFileSync(target, doc, "utf8");
            sink.log("system", `Generated ${path.relative(root, target) || target} (${doc.length} chars).`);
            return;
        }
        case "/load":
            await switchToSession(state, arg || "default", false, sink, deps.waitForMemorySync);
            return;
        case "/retry":
            if (!state.lastFailedPrompt) {
                sink.log("system", "Nothing to retry.");
                return;
            }
            sink.log("user", state.lastFailedPrompt);
            await deps.runAgentTurn(state, state.lastFailedPrompt, sink, { isRetry: true });
            return;
        case "/memory":
            await handleMemoryCommand(state, arg, sink);
            return;
        case "/remember": {
            if (!arg) {
                sink.log("system", "Usage: /remember <fact or preference>");
                return;
            }
            const scope = /\b(this session|local)\b/i.test(arg) ? "session" : "global";
            const ans = sink.confirm
                ? (await sink.confirm(`Save to ${scope} memory: "${arg}"? [y/n]: `)).trim().toLowerCase()
                : "y";
            if (ans !== "y" && ans !== "yes") {
                sink.log("system", "Memory save cancelled.");
                return;
            }
            if (scope === "session") {
                state.session.pinnedMemory.push(arg);
                if (!state.noSession) saveSession(state.session, state.paths);
                sink.log("system", `Pinned to session '${state.session.id}' memory.`);
            } else {
                addGlobalMemory(arg, "user", state.paths);
                sink.log("system", "Saved to Global Shared Memory.");
            }
            return;
        }
        case "/history": {
            if (arg && (!/^\d+$/.test(arg) || Number(arg) < 1)) {
                sink.log("error", "Usage: /history [positive-number]");
                return;
            }
            const limit = arg ? Number.parseInt(arg, 10) : 10;
            const slice = state.session.history.slice(-limit);
            if (!slice.length) {
                sink.log("system", "(empty chat history)");
                return;
            }
            sink.log(
                "system",
                slice
                    .map(
                        (m) =>
                            `${m.role}: ${
                                m.content
                                    ? String(m.content).slice(0, 140).replace(/\n/g, " ")
                                    : `[tool_calls: ${m.tool_calls?.length || 0}]`
                            }`
                    )
                    .join("\n")
            );
            return;
        }
        case "/todos":
            sink.log(
                "system",
                state.session.todos.length
                    ? state.session.todos.map((t, i) => `${i + 1}. [${t.status}] ${t.task}`).join("\n")
                    : "(no todos in current session)"
            );
            return;
        case "/tasks": {
            const mgr = state.bgTasks;
            if (!mgr) {
                sink.log("system", "Background task manager unavailable.");
                return;
            }
            const parts = arg.split(/\s+/).filter(Boolean);
            const sub = (parts[0] || "").toLowerCase();
            if (sub === "kill" && parts[1]) {
                const ok = mgr.killTask(parts[1]);
                sink.log(
                    ok ? "system" : "error",
                    ok ? `Killed background task ${parts[1]}.` : `Task not running or not found: ${parts[1]}`
                );
                return;
            }
            if (sub === "log" && parts[1]) {
                const t = mgr.getTask(parts[1]);
                if (!t) {
                    sink.log("error", `Task not found: ${parts[1]}`);
                    return;
                }
                const tail = t.logs.slice(-40).join("").trim() || "(no output yet)";
                sink.log("system", `Task ${t.id} [${t.status}] (${t.command}):\n${tail}`);
                return;
            }
            const tasks = mgr.listTasks();
            if (!tasks.length) {
                sink.log("system", "No background tasks yet. Use run_command with background=true.");
                return;
            }
            if (!arg && sink.openChoicePicker) {
                const items = tasks.map((t) => ({
                    type: "task",
                    id: t.id,
                    label: `${t.id} [${t.status}] pid=${t.pid ?? "?"}`,
                    desc: t.command.slice(0, 60),
                }));
                const picked = await sink.openChoicePicker("Background Tasks (Enter to view log)", items, "");
                if (!picked) return;
                const t = mgr.getTask(picked);
                if (!t) return;
                const tail = t.logs.slice(-40).join("").trim() || "(no output yet)";
                sink.log("system", `Task ${t.id} [${t.status}] (${t.command}):\n${tail}`);
                if (t.status === "running" && sink.confirm) {
                    const ans = (await sink.confirm(`Kill task ${t.id}? [y/N]: `)).trim().toLowerCase();
                    if (ans === "y" || ans === "yes") {
                        mgr.killTask(t.id);
                        sink.log("system", `Killed task ${t.id}.`);
                    }
                }
                return;
            }
            sink.log(
                "system",
                tasks.map((t) => `  ${t.id} · [${t.status}] pid=${t.pid ?? "?"} · ${t.command}`).join("\n") +
                    "\nTip: /tasks log <id> · /tasks kill <id>"
            );
            return;
        }
        case "/models":
        case "/model": {
            if (!arg) {
                if (sink.openChoicePicker) {
                    await runModelProviderBrowser(state, sink);
                    return;
                }
                sink.log("system", `Provider: ${state.provider.name} · Current model: ${state.model}`);
                return;
            }
            state.model = arg;
            state.session.model = arg;
            updatePersistedSetting("model", arg, state.paths);
            state.persistedSettings.model = arg;
            if (!state.noSession) saveSession(state.session, state.paths);
            sink.syncStatus();
            sink.log("system", `Model switched & saved: ${state.model}`);
            return;
        }
        case "/tools": {
            const next = arg
                ? arg.toLowerCase() === "on" || arg.toLowerCase() === "true"
                : !state.settings.toolsEnabled;
            persistAndApplySetting(state, "toolsEnabled", next, sink);
            sink.log("system", `Tools: ${state.settings.toolsEnabled ? "ON" : "OFF"}`);
            return;
        }
        case "/auto": {
            const wantAuto = arg
                ? arg.toLowerCase() === "on" || arg.toLowerCase() === "true"
                : state.settings.agentMode !== "auto";
            await handleModeCommand(state, wantAuto ? "auto" : "default", sink);
            return;
        }
        case "/system":
            if (!arg) sink.log("system", `System prompt:\n${state.settings.systemPrompt}`);
            else {
                persistAndApplySetting(state, "systemPrompt", arg, sink);
                sink.log("system", "System prompt updated & saved.");
            }
            return;
        case "/compact":
            await deps.compactSession(state, sink);
            return;
        case "/stats": {
            const est = estimateMessagesTokens(formatContextMessages(state));
            const win = state.settings.contextWindow || 128000;
            const pct = ((est / win) * 100).toFixed(1);
            const avgSec = state.session.stats.requests
                ? (state.session.stats.totalMs / state.session.stats.requests / 1000).toFixed(2)
                : "0.00";
            const ttft = state.session.stats.lastTtftMs ?? 0;
            const tps = state.session.stats.lastTokPerSec ?? 0;
            sink.log(
                "system",
                `Session: ${state.session.id} (${state.session.history.length} messages) · Mode: ${state.settings.agentMode}\n` +
                    `Provider: ${state.provider.name} [${state.provider.type}] · Model: ${state.model}\n` +
                    `Context Size: ~${est} / ${win} tokens (${pct}%)\n` +
                    `Average Response Time: ${avgSec}s · Last Time to First Token: ${ttft} ms · Last Generation Speed: ${tps} tok/s\n` +
                    `Total Tokens Used: ${state.session.stats.promptTokens} input, ${state.session.stats.completionTokens} output`
            );
            return;
        }
        case "/copy":
            if (sink.copyLast) sink.copyLast();
            else sink.log("system", "Copy shortcut is available in TUI mode.");
            return;
        case "/select":
            if (sink.toggleSelect) sink.toggleSelect();
            else sink.log("system", "Native terminal selection is already active in plain mode.");
            return;
        case "/clear":
            state.activePrompt = "";
            if (Array.isArray(state.queue)) state.queue.length = 0;
            state.activeAbort?.abort();
            state.memoryAbort?.abort();
            await deps.waitForMemorySync?.(state);
            state.session.history = [];
            state.session.summaryMemory = "";
            state.session.pinnedMemory = [];
            state.session.todos = [];
            state.lastFailedPrompt = "";
            state.sudoPasswords.delete(state.session.id);
            if (!state.noSession) saveSession(state.session, state.paths);
            sink.clear();
            sink.syncStatus();
            sink.log("system", `Session '${state.session.id}' history & session memory cleared.`);
            return;
        case "/exit":
        case "/quit":
            if (sink.exit) sink.exit();
            else process.exit(0);
            return;
        default:
            sink.log("error", `Unknown command: ${cmd}. Type /help`);
    }
}

module.exports = {
    getEnvFallback,
    summarizeArgsShort,
    getContextLabel,
    persistAndApplySetting,
    handleSlash,
    switchToSession,
    openSessionPicker,
    replaySessionHistory,
    TOOL_DEFINITIONS,
};
