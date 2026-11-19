"use strict";

const { AGENT_MODES, loadGlobalMemory } = require("../../store");
const { C, promptLine, promptSecret, promptConfirm } = require("../../ui");
const { getContextLabel } = require("../commands/handlers");

function createPlainSink(interactive, { headless = false, jsonMode = false } = {}) {
    return {
        isTui: false,
        interactive,
        headless,
        log(kind, text) {
            if (jsonMode) {
                if (kind === "error") console.error(text);
                return;
            }
            if (headless) {
                if (kind === "error") console.error(`${C.red}${text}${C.reset}`);
                else if (kind === "tool") console.error(`${C.dim}${text}${C.reset}`);
                else if (kind === "assistant") console.log(text);
                return;
            }
            if (kind === "error") console.error(`${C.red}${text}${C.reset}`);
            else if (kind === "tool" || kind === "meta") console.log(`${C.dim}${text}${C.reset}`);
            else console.log(text);
        },
        clear() {},
        setBusy() {},
        syncStatus() {},
        startThinking(prefix = "Kovence: ", label = "Thinking") {
            if (jsonMode) {
                return {
                    stop() {},
                    write() {},
                    end() {},
                };
            }
            if (headless || !process.stdout.isTTY) {
                if (!headless && prefix) process.stdout.write(prefix);
                return {
                    stop() {},
                    write(tok) {
                        process.stdout.write(tok);
                    },
                    end(hasText) {
                        if (hasText) process.stdout.write("\n");
                    },
                };
            }
            const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
            const dots = ["   ", ".  ", ".. ", "..."];
            let tick = 0;
            let stopped = false;
            let currentLabel = label;
            const render = () => {
                const symbol = frames[tick % frames.length];
                const blink = dots[Math.floor(tick / 2) % dots.length];
                process.stdout.write(
                    `\r\x1b[K${C.cyan}${prefix}${C.reset}${C.yellow}${symbol} ${currentLabel}${blink}${C.reset}`
                );
                tick++;
            };
            render();
            const timer = setInterval(render, 100);
            return {
                setLabel(newLabel) {
                    if (newLabel) currentLabel = newLabel;
                },
                stop(keepPrefix = true) {
                    if (stopped) return;
                    stopped = true;
                    clearInterval(timer);
                    process.stdout.write(keepPrefix ? `\r\x1b[K${C.cyan}${prefix}${C.reset}` : "\r\x1b[K");
                },
                write(tok) {
                    process.stdout.write(tok);
                },
                end(hasText) {
                    if (hasText) process.stdout.write("\n");
                },
            };
        },
        confirm: (label) => (interactive ? promptConfirm(`${C.yellow}${label}${C.reset}`) : Promise.resolve("n")),
        askPrompt: (label) => (interactive ? promptLine(label, []) : Promise.resolve("")),
        askPassword: interactive ? (label) => promptSecret(label) : null,
        startProgress(initialText = "") {
            if (jsonMode || headless || !process.stdout.isTTY) {
                return { update() {}, done() {} };
            }
            if (initialText) process.stdout.write(`\r\x1b[K${C.yellow}${initialText}${C.reset}`);
            return {
                update(text) {
                    process.stdout.write(`\r\x1b[K${C.yellow}${text}${C.reset}`);
                },
                done(finalText) {
                    process.stdout.write(`\r\x1b[K${C.green}${finalText}${C.reset}\n`);
                },
            };
        },
    };
}

function addTuiBanner(tui, state) {
    const gCount = loadGlobalMemory(state.paths).length;
    tui.addBlock(
        "brand-cyan",
        [
            "",
            "  ██╗  ██╗ ██████╗ ██╗   ██╗███████╗███╗   ██╗ ██████╗███████╗",
            "  ██║ ██╔╝██╔═══██╗██║   ██║██╔════╝████╗  ██║██╔════╝██╔════╝",
            "  █████╔╝ ██║   ██║██║   ██║█████╗  ██╔██╗ ██║██║     █████╗  ",
        ].join("\n")
    );
    tui.addBlock(
        "brand-magenta",
        [
            "  ██╔═██╗ ██║   ██║╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██║     ██╔══╝  ",
            "  ██║  ██╗╚██████╔╝ ╚████╔╝ ███████╗██║ ╚████║╚██████╗███████╗",
            "  ╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝",
        ].join("\n")
    );
    tui.addBlock(
        "system",
        `Kovence CLI · https://kovence.com\nAPI: ${state.provider.name} [${state.provider.type}] · Model: ${state.model}\nMode: ${state.settings.agentMode} · Session: ${state.session.id} (${state.session.history.length} msgs, ${getContextLabel(state)}, globalMem: ${gCount})\n`
    );
}

function createTuiSink(tui, state) {
    return {
        isTui: true,
        interactive: true,
        headless: false,
        log(kind, text) {
            tui.addBlock(kind, text);
        },
        setInput(text) {
            tui.setInput(text);
        },
        clear() {
            tui.clearBlocks();
            addTuiBanner(tui, state);
        },
        setBusy(label) {
            tui.setStatus({ busyLabel: label, isBusy: Boolean(state.isBusy || label), queueLen: state.queue.length });
        },
        syncStatus() {
            tui.setStatus({
                sessionId: state.session.id,
                provider: state.provider.name,
                providerType: state.provider.type,
                model: state.model,
                ctxText: getContextLabel(state),
                agentMode: state.settings.agentMode,
                colorScheme: state.settings.colorScheme || "amber",
                tools: state.settings.toolsEnabled,
                auto: state.settings.agentMode === "auto",
                showTips: state.settings.showTips !== false,
                showActiveTasks: state.settings.showActiveTasks !== false,
                activeBgTasks: state.bgTasks?.activeCount?.() || 0,
                activeTodos: (state.session?.todos || []).filter((t) => t.status !== "done").length,
                notifications: state.settings.notifications !== false,
                isBusy: Boolean(state.isBusy),
                queueLen: state.queue.length,
            });
        },
        notify() {
            if (state.settings?.notifications !== false && process.stdout.isTTY) {
                process.stdout.write("\x07");
            }
        },
        startThinking(_prefix = "Kovence: ", initialLabel = "Thinking") {
            const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
            const dots = ["   ", ".  ", ".. ", "..."];
            let tick = 0;
            let stopped = false;
            let currentLabel = initialLabel;
            const block = tui.addBlock("thinking", `⠋ ${currentLabel}   `);
            const timer = setInterval(() => {
                tick++;
                const symbol = frames[tick % frames.length];
                const blink = dots[Math.floor(tick / 2) % dots.length];
                tui.updateBlock(block, `${symbol} ${currentLabel}${blink}`);
            }, 100);

            return {
                setLabel(newLabel) {
                    if (stopped || !newLabel) return;
                    currentLabel = newLabel;
                    const symbol = frames[tick % frames.length];
                    const blink = dots[Math.floor(tick / 2) % dots.length];
                    tui.updateBlock(block, `${symbol} ${currentLabel}${blink}`);
                },
                stop(keepForStream = true) {
                    if (stopped) return;
                    stopped = true;
                    clearInterval(timer);
                    if (keepForStream) {
                        block.kind = "assistant";
                        block._streaming = true;
                        tui.updateBlock(block, "");
                    } else {
                        const idx = tui.blocks.indexOf(block);
                        if (idx !== -1) tui.blocks.splice(idx, 1);
                        tui.scheduleRender();
                    }
                },
                write(tok) {
                    tui.appendBlock(block, tok);
                },
                end() {
                    if (block._streaming) {
                        block._streaming = false;
                        block._cache = null;
                        tui.scheduleRender();
                    }
                },
            };
        },
        confirm: (label) => tui.askModal(label, false),
        askPrompt: (label) => tui.askModal(label, false),
        askPassword: (label) => tui.askModal(label, true),
        openSettings: () => tui.openSettings(),
        openPermissions: () => {
            tui.settingsScreen = null;
            tui.openManagePermissions();
        },
        async openChoicePicker(title, items, currentId = "") {
            if (!items || !items.length) return "";
            const initialIdx = Math.max(
                0,
                items.findIndex((x) => x.id === currentId)
            );
            const res = await tui.openPicker(title, items, {
                initialIdx,
                hint: "↑/↓ select · Enter apply · Esc close",
            });
            return res?.action === "select" ? res.item?.id || "" : "";
        },
        async openModePicker(currentMode) {
            const modeMeta = [
                { id: "default", desc: "Ask confirmation for file edits, downloads & commands" },
                { id: "accept-edits", desc: "Auto-approve file edits; confirm commands & downloads" },
                { id: "plan", desc: "Research & plan only (all mutations blocked)" },
                { id: "auto", desc: "Auto-allow tools & sudo (1-time session sudo password)" },
            ];
            const items = modeMeta.map((m) => ({
                type: "mode",
                id: m.id,
                label: `${m.id === currentMode ? "● " : "  "}${m.id}`,
                desc: m.desc,
            }));
            const initialIdx = Math.max(
                0,
                modeMeta.findIndex((m) => m.id === currentMode)
            );
            const res = await tui.openPicker("Select Agent Mode (Shift+Tab)", items, {
                initialIdx,
                hint: "↑/↓ select · Enter apply · Esc close",
            });
            return res?.action === "select" ? res.item?.id || "" : "";
        },
        startProgress(initialText = "") {
            const block = tui.addBlock("tool", initialText || "⬇ Starting download...");
            return {
                update(text) {
                    tui.updateBlock(block, text);
                },
                done(finalText) {
                    tui.updateBlock(block, finalText || block.text);
                },
            };
        },
        startToolCall(label, { collapsible = true, expanded = false } = {}) {
            const isWrite = /write_file|edit_file|multi_edit|apply_patch/.test(label);
            const isRead = /read_file|glob_files|grep_files/.test(label);
            const block = tui.addBlock("tool", label, {
                collapsible,
                expanded,
                details: [],
                statusLine: isWrite ? "writing..." : isRead ? "reading..." : "running...",
            });
            const details = [];
            let lastUpdateAt = 0;

            return {
                block,
                /**
                 * Called once at write start with { filePath, content }.
                 * Populates block.writeStats so the TUI can animate and show live stats.
                 */
                startWrite({ filePath = "", content = "" } = {}) {
                    const lines = String(content || "").split(/\r?\n/);
                    const dir = filePath ? filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || "." : "";
                    block.writeStats = {
                        filePath: String(filePath || ""),
                        dir: String(dir),
                        totalLines: lines.length,
                        totalChars: content.length,
                        startTime: Date.now(),
                        // 5-line rolling preview (last 5 non-blank lines)
                        previewLines: lines.filter((l) => l.trim()).slice(-5),
                        done: false,
                    };
                    block._ver = (block._ver || 0) + 1;
                    block._cache = null;
                    tui.scheduleRender();
                },
                pushOutput(rawChunk) {
                    const cleaned = String(rawChunk || "")
                        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
                        .replace(/\x1b\[[0-9;?=<>]*[a-zA-Z~]/g, "");
                    const parts = cleaned.split(/\r?\n/);
                    for (const part of parts) {
                        // If a line contains \r progress updates, keep the final segment of that line
                        const crSegments = part
                            .split("\r")
                            .map((s) => s.trim())
                            .filter(Boolean);
                        if (!crSegments.length) continue;
                        const lastSeg = crSegments[crSegments.length - 1];
                        if (part.includes("\r") && details.length > 0) {
                            details[details.length - 1] = lastSeg;
                        } else {
                            details.push(lastSeg);
                            if (details.length > 80) details.shift();
                        }
                    }
                    if (!details.length) return;
                    const latest = details[details.length - 1];
                    const now = Date.now();
                    if (now - lastUpdateAt >= 80) {
                        lastUpdateAt = now;
                        tui.setBlockDetails(block, [...details], latest);
                    } else {
                        block.details = [...details];
                        block.statusLine = latest;
                    }
                },
                finish(fullOutputText = "", isError = false) {
                    // Mark write as done so animation stops.
                    if (block.writeStats) block.writeStats.done = true;
                    if (!details.length && fullOutputText) {
                        const fallbackLines = String(fullOutputText)
                            .split(/\r?\n/)
                            .map((l) => l.trimEnd())
                            .filter(Boolean)
                            .slice(-60);
                        details.push(...fallbackLines);
                    }
                    const summaryLine = isError
                        ? String(fullOutputText || "failed").split(/\r?\n/)[0]
                        : details[details.length - 1] || String(fullOutputText || "done").split(/\r?\n/)[0];
                    tui.setBlockDetails(block, [...details], summaryLine);
                },
            };
        },
    };
}

function nextAgentMode(currentMode) {
    const idx = Math.max(0, AGENT_MODES.indexOf(currentMode));
    return AGENT_MODES[(idx + 1) % AGENT_MODES.length];
}

module.exports = {
    createPlainSink,
    addTuiBanner,
    createTuiSink,
    nextAgentMode,
};
