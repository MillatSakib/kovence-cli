#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const pkg = require("./package.json");
const {
    AGENT_MODES,
    getDefaultPaths,
    safeId,
    loadSettings,
    resolveEffectiveSettings,
    resolveEffectiveModel,
    loadGlobalMemory,
    loadProviders,
    createEmptySession,
    loadSession,
    saveSession,
    listSessions,
    listCombinedRules,
    removePermissionRuleByIndex,
    loadInputHistory,
    saveInputHistory,
} = require("./store");
const { capOutput, executeTool } = require("./tools");
const { BackgroundTaskManager } = require("./src/tools/tasks");
const { C, promptLine } = require("./ui");
const { KovenceTUI } = require("./tui");
const { buildProviderUrls, listProviderModels } = require("./providers");
const { parseArgs, getHelpText } = require("./src/cli/args");
const { createPlainSink, addTuiBanner, createTuiSink, nextAgentMode } = require("./src/cli/sinks");
const {
    getEnvFallback,
    getContextLabel,
    persistAndApplySetting,
    handleSlash,
    switchToSession,
    openSessionPicker,
    replaySessionHistory,
} = require("./src/commands/handlers");
const { runAgentTurn, compactSession, waitForMemorySync } = require("./src/agent/turn");

function makeAutoSessionId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 5);
    return `session-${stamp}-${rand}`;
}

async function readPipedStdin() {
    if (process.stdin.isTTY) return "";
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
}

function printBanner(state) {
    const gCount = loadGlobalMemory(state.paths).length;
    const { chatUrl } = buildProviderUrls(state.provider);
    const art = [
        `${C.cyan}${C.bold}  ██╗  ██╗ ██████╗ ██╗   ██╗███████╗███╗   ██╗ ██████╗███████╗${C.reset}`,
        `${C.cyan}${C.bold}  ██║ ██╔╝██╔═══██╗██║   ██║██╔════╝████╗  ██║██╔════╝██╔════╝${C.reset}`,
        `${C.cyan}${C.bold}  █████╔╝ ██║   ██║██║   ██║█████╗  ██╔██╗ ██║██║     █████╗  ${C.reset}`,
        `${C.magenta}${C.bold}  ██╔═██╗ ██║   ██║╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██║     ██╔══╝  ${C.reset}`,
        `${C.magenta}${C.bold}  ██║  ██╗╚██████╔╝ ╚████╔╝ ███████╗██║ ╚████║╚██████╗███████╗${C.reset}`,
        `${C.magenta}${C.bold}  ╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝${C.reset}`,
    ];
    console.log();
    console.log(art.join("\n"));
    console.log(
        `  ${C.bold}Kovence CLI${C.reset} ${C.dim}· https://kovence.com · ${chatUrl}${C.reset}\n` +
            `  ${C.dim}──────────────────────────────────────────────────────────────${C.reset}\n` +
            `  API     : ${C.cyan}${state.provider.name}${C.reset} [${state.provider.type}] · Model: ${C.cyan}${state.model}${C.reset}\n` +
            `  Session : ${C.magenta}${state.session.id}${C.reset} (${state.session.history.length} msgs, ${getContextLabel(state)}, globalMem: ${gCount})\n` +
            `  Mode    : ${C.yellow}${state.settings.agentMode}${C.reset} · Tools ${state.settings.toolsEnabled ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`} · Memory Sync ${state.settings.autoSummarize ? `${C.green}ON${C.reset}` : "OFF"}\n` +
            `  ${C.dim}Tip: @file attaches files · /mode plan|accept-edits|auto · /settings · /help${C.reset}\n`
    );
}

/**
 * Install centralized terminal/child cleanup across all exit and signal paths (B11).
 */
function installCleanupHandlers(state, getTui, isInteractive) {
    let cleaned = false;
    const cleanup = (exitCode = null, fatalErr = null) => {
        if (!cleaned) {
            cleaned = true;
            try {
                state.activeAbort?.abort();
            } catch {}
            try {
                state.memoryAbort?.abort();
            } catch {}
            try {
                state.bgTasks?.killAll();
            } catch {}
            try {
                getTui?.()?.leave();
            } catch {}
            try {
                if (!state.noSession && state.session) saveSession(state.session, state.paths);
            } catch {}
            if (fatalErr) {
                console.error(`${C.red}Fatal:${C.reset} ${fatalErr.message || fatalErr}`);
            } else if (isInteractive && state.session?.id && !state.noSession) {
                console.log(`${C.dim}Resume anytime: kovence --session ${state.session.id}${C.reset}`);
            }
        }
        if (exitCode !== null) process.exit(exitCode);
    };

    process.on("exit", () => cleanup(null, null));
    process.on("SIGTERM", () => cleanup(0, null));
    process.on("SIGHUP", () => cleanup(0, null));
    process.on("uncaughtException", (err) => cleanup(1, err));
    process.on("unhandledRejection", (err) => cleanup(1, err));
    return cleanup;
}

async function runDirectShell(state, cmdText, sink) {
    const command = String(cmdText || "").trim();
    if (!command) return;
    sink.log("meta", `! ${command}`);
    try {
        const out = await executeTool(
            "run_command",
            { command },
            {
                workspaceRoot: state.workspaceRoot || process.cwd(),
                extraDirs: state.extraDirs || [],
                settings: state.settings,
                askPrompt: sink.askPrompt,
                askPassword: sink.askPassword,
                bgTasks: state.bgTasks,
                approvedByUser: state.settings?.agentMode === "auto",
            }
        );
        sink.log("tool", out);
    } catch (err) {
        sink.log("error", `Shell error: ${err.message}`);
    }
}

async function runDoctor(paths, envFallback) {
    const { execFileSync } = require("node:child_process");
    const hasBin = (bin) => {
        try {
            execFileSync("which", [bin], { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    };
    const checks = [];
    const nodeParts = process.versions.node.split(".").map(Number);
    const nodeOk = nodeParts[0] > 20 || (nodeParts[0] === 20 && nodeParts[1] >= 12);
    checks.push({ name: "Node.js (>=20.12)", ok: nodeOk, detail: `v${process.versions.node}` });
    checks.push({ name: "git", ok: hasBin("git"), detail: hasBin("git") ? "installed" : "missing (optional)" });
    checks.push({
        name: "ripgrep (rg)",
        ok: hasBin("rg"),
        detail: hasBin("rg") ? "installed" : "missing (JS fallback active)",
    });
    checks.push({ name: "sudo", ok: hasBin("sudo"), detail: hasBin("sudo") ? "installed" : "missing" });
    checks.push({ name: "Global config dir", ok: true, detail: paths.globalDir });
    checks.push({ name: "Project .kovence dir", ok: true, detail: paths.projectDir });

    const provStore = loadProviders(envFallback, paths);
    const active = provStore.providers[provStore.active];
    if (!active || !active.apiKey || active.apiKey === "sk-your-virtual-key") {
        checks.push({ name: "Active API provider", ok: false, detail: "API key not configured (.env or /api add)" });
    } else {
        try {
            const models = await listProviderModels(active, { timeoutMs: 5000 });
            checks.push({
                name: `Provider '${active.name}' [${active.type}]`,
                ok: true,
                detail: `reachable (${models.length} models listed)`,
            });
        } catch (err) {
            checks.push({
                name: `Provider '${active.name}' [${active.type}]`,
                ok: false,
                detail: err.message,
            });
        }
    }

    console.log(`\n${C.bold}Kovence Doctor (v${pkg.version})${C.reset}`);
    for (const c of checks) {
        const icon = c.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        console.log(`  ${icon} ${c.name}: ${c.detail}`);
    }
    console.log();
}

async function runPlainRepl(state) {
    const sink = createPlainSink(true);
    installCleanupHandlers(state, null, true);
    printBanner(state);
    const inputHistory = loadInputHistory(state.paths);

    let lastSigIntAt = 0;
    process.on("SIGINT", () => {
        const now = Date.now();
        if (state.activeAbort) {
            if (now - lastSigIntAt < 2500) {
                process.exit(0);
            }
            lastSigIntAt = now;
            state.activeAbort.abort();
            console.log(`\n${C.yellow}Task cancelled (press Ctrl+C again to exit).${C.reset}`);
        } else {
            process.exit(0);
        }
    });

    const slashDeps = { waitForMemorySync, runAgentTurn, compactSession };

    while (true) {
        const raw = await promptLine(
            `${C.green}[${state.session.id}:${state.settings.agentMode}] You: ${C.reset}`,
            inputHistory
        );
        if (raw === null) break;
        const input = raw.trim();
        if (!input) continue;
        if (!input.startsWith("/") && inputHistory[inputHistory.length - 1] !== input) {
            inputHistory.push(input);
            saveInputHistory(inputHistory, state.paths);
        }
        if (input === "/exit" || input === "/quit") break;

        if (input.startsWith("!")) {
            await runDirectShell(state, input.slice(1), sink);
            console.log();
            continue;
        }

        if (input.startsWith("/")) {
            try {
                await handleSlash(state, input, sink, slashDeps);
            } catch (e) {
                sink.log("error", `Error: ${e.message}`);
            }
            console.log();
            continue;
        }

        try {
            if (!state.provider || state.provider.empty || !state.provider.baseUrl || !state.provider.apiKey) {
                sink.log("system", "No AI provider configured yet. Use /api add or /models to add a custom provider.");
                console.log();
                continue;
            }
            await runAgentTurn(state, input, sink);
        } catch (e) {
            if (e.name !== "AbortError") sink.log("error", `Error: ${e.message}`);
        }
        console.log();
    }
}

async function runTuiRepl(state) {
    let tui = null;
    let sink = null;
    const cleanup = installCleanupHandlers(state, () => tui, true);
    const slashDeps = { waitForMemorySync, runAgentTurn, compactSession };

    process.on("SIGINT", () => cleanup(0, null));

    const drainQueue = async () => {
        if (state.isBusy) return;
        state.isBusy = true;
        try {
            while (state.queue.length) {
                const item = state.queue.shift();
                sink.syncStatus();
                if (item.startsWith("/")) {
                    try {
                        await handleSlash(state, item, sink, slashDeps);
                    } catch (e) {
                        sink.log("error", `Error: ${e.message}`);
                    }
                    continue;
                }
                state.activePrompt = item;
                sink.log("user", item);
                try {
                    if (!state.provider || state.provider.empty || !state.provider.baseUrl || !state.provider.apiKey) {
                        sink.log(
                            "system",
                            "No AI provider configured yet. Use /api add or /models to add a custom provider."
                        );
                        state.activePrompt = "";
                        continue;
                    }
                    await runAgentTurn(state, item, sink);
                    state.activePrompt = "";
                } catch (e) {
                    state.activePrompt = "";
                    if (e.name === "AbortError" || e.aborted) {
                        sink.log("system", "Task cancelled — prompt restored to input box.");
                    } else {
                        sink.log("error", `Error: ${e.message}`);
                    }
                }
            }
        } finally {
            state.activePrompt = "";
            state.isBusy = false;
            state.isDownloading = false;
            sink.setBusy("");
            sink.syncStatus();
        }
    };

    const shutdown = () => cleanup(0, null);

    tui = new KovenceTUI({
        onSubmit(raw) {
            if (raw === "/exit" || raw === "/quit") {
                shutdown();
                return;
            }
            // Slash commands execute immediately even while an agent turn is running
            if (raw.startsWith("/")) {
                Promise.resolve(handleSlash(state, raw, sink, slashDeps)).catch((e) => {
                    sink.log("error", `Error: ${e.message}`);
                });
                return;
            }
            if (raw.startsWith("!")) {
                Promise.resolve(runDirectShell(state, raw.slice(1), sink)).catch((e) => {
                    sink.log("error", `Error: ${e.message}`);
                });
                return;
            }
            if (state.isBusy) {
                if (state.settings.queuedMessages === "interrupt" && !state.isDownloading) {
                    state.activePrompt = "";
                    state.activeAbort?.abort();
                    state.queue.unshift(raw);
                    tui.flashNotice("Interrupting current turn...", 1800);
                    sink.syncStatus();
                    return;
                }
                state.queue.push(raw);
                tui.addBlock(
                    "queued",
                    state.isDownloading
                        ? `[Queued while downloading #${state.queue.length}] ${raw}`
                        : `[Queued #${state.queue.length}] ${raw}`
                );
                sink.syncStatus();
                return;
            }
            state.queue.push(raw);
            drainQueue();
        },
        onCancel() {
            const restoreParts = [];
            if (state.activePrompt) {
                restoreParts.push(state.activePrompt);
                state.activePrompt = "";
            }
            if (state.queue.length) {
                restoreParts.push(...state.queue);
                state.queue.length = 0;
            }
            if (tui.input && tui.input.trim()) {
                restoreParts.push(tui.input);
            }
            if (restoreParts.length) {
                tui.setInput(restoreParts.join("\n"));
            }
            tui.removeQueuedBlocks();
            state.activeAbort?.abort();
            state.memoryAbort?.abort();
            tui.cancelModal();
            sink.syncStatus();
        },
        onOpenSessions() {
            openSessionPicker(state, tui, sink, waitForMemorySync);
        },
        async onNewSession() {
            const rawName = (await tui.askModal("New session name (blank = auto): ", false)).trim();
            const id = rawName || `session-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
            state.activePrompt = "";
            state.queue.length = 0;
            state.activeAbort?.abort();
            await switchToSession(state, id, true, sink, waitForMemorySync);
        },
        onCycleMode() {
            const next = nextAgentMode(state.settings.agentMode);
            persistAndApplySetting(state, "agentMode", next, sink);
            tui.flashNotice(`Agent Mode: ${next}`, 1800);
        },
        onGetSettings() {
            return {
                ...state.persistedSettings,
                ...state.settings,
                provider: state.provider?.name || state.settings.provider,
                model: state.model || state.settings.model,
            };
        },
        onUpdateSetting(key, value) {
            persistAndApplySetting(state, key, value, sink);
        },
        onGetProviders() {
            const store = loadProviders(getEnvFallback(), state.paths);
            return Object.keys(store.providers);
        },
        onGetModels() {
            const cached = state.cachedProviderModels?.get(state.provider?.name) || [];
            const saved = Array.isArray(state.provider?.models) ? state.provider.models : [];
            return [...new Set([state.model, ...saved, ...cached, state.provider?.defaultModel].filter(Boolean))];
        },
        async onRefreshModels() {
            try {
                const live = await listProviderModels(state.provider, { timeoutMs: 6000 });
                if (Array.isArray(live) && live.length) {
                    state.cachedProviderModels?.set(state.provider.name, live);
                    tui?.scheduleRender();
                }
            } catch {}
        },
        async onPickSettingChoice(key) {
            const savedSettings = tui.settingsScreen ? { ...tui.settingsScreen } : null;
            tui.settingsScreen = null;
            try {
                if (key === "provider") {
                    const store = loadProviders(getEnvFallback(), state.paths);
                    const items = Object.values(store.providers).map((p) => ({
                        type: "provider",
                        id: p.name,
                        label: `${p.name === state.provider.name ? "● " : "  "}${p.name}`,
                        desc: `[${p.type}] ${p.baseUrl}`,
                    }));
                    const picked = await sink.openChoicePicker("Select Provider", items, state.provider.name);
                    if (picked) {
                        persistAndApplySetting(state, "provider", picked, sink);
                    }
                } else if (key === "model") {
                    let live = state.cachedProviderModels?.get(state.provider.name) || [];
                    if (!live.length) {
                        try {
                            live = await listProviderModels(state.provider, { timeoutMs: 6000 });
                            if (live.length) state.cachedProviderModels?.set(state.provider.name, live);
                        } catch {}
                    }
                    const saved = Array.isArray(state.provider?.models) ? state.provider.models : [];
                    const allModels = [
                        ...new Set([state.model, ...saved, ...live, state.provider?.defaultModel].filter(Boolean)),
                    ];
                    const items = [
                        ...allModels.map((id) => ({
                            type: "model",
                            id,
                            label: `${id === state.model ? "● " : "  "}${id}`,
                            desc: saved.includes(id) ? "saved" : "api",
                        })),
                        { type: "new", id: "__custom__", label: "+ Enter custom model ID", desc: "" },
                    ];
                    const picked = await sink.openChoicePicker(
                        `Select Model (${state.provider.name})`,
                        items,
                        state.model
                    );
                    if (picked === "__custom__") {
                        const custom = (await tui.askModal("Custom model ID: ", false)).trim();
                        if (custom) persistAndApplySetting(state, "model", custom, sink);
                    } else if (picked) {
                        persistAndApplySetting(state, "model", picked, sink);
                    }
                }
            } finally {
                if (savedSettings) {
                    tui.settingsScreen = savedSettings;
                    tui.scheduleRender();
                }
            }
        },
        onGetPermissionRules() {
            return listCombinedRules(state.sessionRules, state.paths);
        },
        onRemovePermissionRule(rule) {
            if (rule.origin === "session") {
                const idx = state.sessionRules.findIndex((r) => r.id === rule.id);
                if (idx >= 0) return state.sessionRules.splice(idx, 1)[0];
                return null;
            }
            const all = listCombinedRules(state.sessionRules, state.paths);
            const idxOneBased = all.findIndex((r) => r.id === rule.id && r.origin === rule.origin) + 1;
            const sessionLen = state.sessionRules.length;
            if (idxOneBased > sessionLen) {
                return removePermissionRuleByIndex(idxOneBased - sessionLen, state.paths);
            }
            return null;
        },
        workspaceRoot: state.workspaceRoot || process.cwd(),
        initialInputHistory: loadInputHistory(state.paths),
        onSaveInputHistory: (items) => saveInputHistory(items, state.paths),
        onExit: shutdown,
    });

    sink = createTuiSink(tui, state);
    sink.openSessions = () => openSessionPicker(state, tui, sink, waitForMemorySync);
    sink.copyLast = () => tui.copyLastResponse();
    sink.toggleSelect = () => tui.toggleMouseMode();
    sink.exit = shutdown;
    tui.enter();
    sink.syncStatus();

    addTuiBanner(tui, state);
    replaySessionHistory(sink, state);
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }

    if (opts.version) {
        console.log(`kovence-cli v${pkg.version}`);
        return;
    }
    if (opts.help) {
        console.log(getHelpText());
        return;
    }

    const paths = getDefaultPaths();
    const envFallback = getEnvFallback();
    if (opts.doctor) {
        await runDoctor(paths, envFallback);
        return;
    }
    const provStore = loadProviders(envFallback, paths);
    const activeProvName = opts.provider ? safeId(opts.provider) : provStore.active;
    let provider = activeProvName ? provStore.providers[activeProvName] : null;
    if (opts.provider && !provider) {
        console.error(`Provider '${activeProvName}' not found. Use /api list or /api add.`);
        process.exit(1);
    }
    const piped = await readPipedStdin();
    if (!provider || !provider.apiKey || provider.apiKey === "sk-your-virtual-key") {
        if (opts.prompt || piped) {
            console.error(
                "No AI provider configured. Run interactively and use /api add or /models to add a provider."
            );
            process.exit(1);
        }
        provider = {
            name: "(none)",
            type: "openai",
            baseUrl: "",
            apiKey: "",
            defaultModel: "",
            models: [],
            empty: true,
        };
    }

    const persistedSettings = loadSettings(paths);
    let sessionId = "";
    let isFreshSession = false;
    if (opts.newSession) {
        sessionId = safeId(opts.newSession);
        isFreshSession = true;
    } else if (opts.session) {
        sessionId = safeId(opts.session);
    } else if (opts.continueLatest) {
        const recent = listSessions(paths);
        sessionId = recent[0]?.id || makeAutoSessionId();
        isFreshSession = recent.length === 0;
    } else {
        sessionId = makeAutoSessionId();
        isFreshSession = true;
    }

    const session =
        opts.noSession || isFreshSession ? createEmptySession(sessionId, "") : loadSession(sessionId, "", paths);

    const runtimeOverrides = {
        cliAuto: opts.autoApprove === true,
        cliMode: opts.mode || "",
        cliProvider: opts.provider || "",
        sessionAgentMode: !isFreshSession && !opts.mode && !opts.autoApprove ? session.agentMode || "" : "",
    };
    const settings = resolveEffectiveSettings(persistedSettings, runtimeOverrides);
    if (opts.system) settings.systemPrompt = opts.system;
    if (opts.toolsEnabled !== null) settings.toolsEnabled = opts.toolsEnabled;
    if (opts.autoSummarize !== null) settings.autoSummarize = opts.autoSummarize;
    if (opts.temperature !== null) settings.temperature = opts.temperature;
    if (opts.maxTokens !== null) settings.maxTokens = opts.maxTokens;

    let model = resolveEffectiveModel({
        cliModel: opts.model,
        sessionModel: isFreshSession ? "" : session.model,
        persistedModel: persistedSettings.model,
        providerDefaultModel: provider.defaultModel,
    });
    if (!model && !provider.empty && provider.baseUrl) {
        const ids = await listProviderModels(provider);
        if (!ids.length) {
            console.error("Provider theke kono model pawa jay ni.");
            process.exit(1);
        }
        model = ids[0];
    }
    session.model = model;
    if (!opts.noSession) saveSession(session, paths);

    const state = {
        paths,
        workspaceRoot: paths.cwd,
        extraDirs: opts.addDirs || [],
        noSession: opts.noSession,
        cliModel: opts.model || "",
        provider,
        model,
        persistedSettings,
        runtimeOverrides,
        settings,
        session,
        sessionRules: [],
        capabilities: { _byModel: new Map() },
        activeAbort: null,
        memoryAbort: null,
        memorySyncPromise: null,
        activePrompt: "",
        lastFailedPrompt: "",
        sudoPasswords: new Map(),
        cachedProviderModels: new Map(),
        bgTasks: new BackgroundTaskManager(),
        queue: [],
        isBusy: false,
        isDownloading: false,
        debug: Boolean(opts.debug),
        headless: false,
    };

    if (opts.prompt || piped) {
        state.headless = true;
        const combined = [opts.prompt, piped ? `\`\`\`\n${capOutput(piped)}\n\`\`\`` : ""].filter(Boolean).join("\n\n");
        const sink = createPlainSink(false, { headless: true, jsonMode: opts.json });
        try {
            const result = await runAgentTurn(state, combined, sink);
            if (opts.json) {
                console.log(
                    JSON.stringify(
                        {
                            ok: true,
                            sessionId: state.session.id,
                            provider: state.provider.name,
                            model: state.model,
                            answer: result.answer,
                            toolsUsed: result.toolsUsed,
                            usage: result.usage,
                            elapsedMs: result.elapsedMs,
                        },
                        null,
                        2
                    )
                );
            }
        } catch (err) {
            if (opts.json) {
                console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
            } else {
                console.error(`Error: ${err.message}`);
            }
            process.exit(1);
        }
        return;
    }

    const usePlain = opts.plain || settings.renderingMode === "inline" || !process.stdin.isTTY || !process.stdout.isTTY;
    if (!usePlain) {
        await runTuiRepl(state);
    } else {
        await runPlainRepl(state);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`${C.red}Fatal:${C.reset} ${e.message}`);
        process.exit(1);
    });
}

module.exports = { main };
