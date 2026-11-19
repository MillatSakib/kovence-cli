"use strict";

const readline = require("node:readline");
const { stripAnsi, displayWidth, prevGraphemeBoundary, nextGraphemeBoundary } = require("./src/tui/text_width");

const useColor = process.stdout.isTTY && !(process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "");
const C = useColor
    ? {
          dim: "\x1b[2m",
          bold: "\x1b[1m",
          cyan: "\x1b[38;5;208m",
          green: "\x1b[32m",
          yellow: "\x1b[38;5;214m",
          red: "\x1b[31m",
          magenta: "\x1b[38;5;202m",
          bgSel: "\x1b[48;5;166m\x1b[97m",
          reset: "\x1b[0m",
      }
    : { dim: "", bold: "", cyan: "", green: "", yellow: "", red: "", magenta: "", bgSel: "", reset: "" };

const SLASH_COMMANDS = [
    { cmd: "/help", desc: "Show all commands" },
    { cmd: "/mode", desc: "Switch agent mode (default|accept-edits|plan|auto)" },
    { cmd: "/settings", desc: "Open interactive Settings panel (Ctrl+,)" },
    { cmd: "/set", desc: "Update persisted setting (/set <key> <val>)", hasArg: true },
    { cmd: "/api", desc: "Switch/add OpenAI or Anthropic custom APIs" },
    { cmd: "/model", desc: "Pick or switch active model (/model [name])" },
    { cmd: "/sessions", desc: "Session picker / manage (list|new|switch|delete) (Ctrl+S)" },
    { cmd: "/new", desc: "Open a new isolated session (Ctrl+N)" },
    { cmd: "/retry", desc: "Retry the last failed/aborted user turn" },
    { cmd: "/history", desc: "Show session chat history", hasArg: true },
    { cmd: "/memory", desc: "Show/manage session & global memory", hasArg: true },
    { cmd: "/todos", desc: "Show current session multi-step todos" },
    { cmd: "/compact", desc: "Compact history into session summary" },
    { cmd: "/stats", desc: "Show full context size, speed & token stats" },
    { cmd: "/copy", desc: "Copy last AI response to clipboard (Ctrl+Y)" },
    { cmd: "/select", desc: "Toggle native terminal mouse select mode (F2)" },
    { cmd: "/save", desc: "Rename/save current session", hasArg: true },
    { cmd: "/rename", desc: "Rename current session", hasArg: true },
    { cmd: "/fork", desc: "Fork current session into a new branch", hasArg: true },
    { cmd: "/export", desc: "Export session transcript (md|json)", hasArg: true },
    { cmd: "/edit-last", desc: "Pop last turn and restore prompt for editing" },
    { cmd: "/undo", desc: "Rollback the last file edit/write/delete checkpoint" },
    { cmd: "/init", desc: "Scan project & generate KOVENCE.md instructions" },
    { cmd: "/tasks", desc: "List, view logs, or stop background shell tasks", hasArg: true },
    { cmd: "/cost", desc: "Show estimated session token cost in USD" },
    { cmd: "/clear", desc: "Clear current session history & memory" },
    { cmd: "/exit", desc: "Exit Kovence CLI" },
];

const SUBCOMMAND_HINTS = {
    "/mode": [
        { fill: "/mode default", desc: "Confirm mutating actions per policy" },
        { fill: "/mode accept-edits", desc: "Auto-approve file edits, confirm commands" },
        { fill: "/mode plan", desc: "Research & plan only (mutations blocked)" },
        { fill: "/mode auto", desc: "Auto-allow except hard denylist & non-workspace" },
    ],
    "/api": [
        { fill: "/api list", desc: "List configured OpenAI/Anthropic APIs" },
        { fill: "/api add", desc: "Add a custom API provider & models interactively" },
        { fill: "/api add-model ", desc: "<provider> <model1,model2...> Add more models" },
        { fill: "/api use ", desc: "Switch active API provider" },
        { fill: "/api rm ", desc: "Remove a custom API provider" },
    ],
    "/sessions": [
        { fill: "/sessions list", desc: "List all sessions" },
        { fill: "/sessions new ", desc: "Create new isolated session" },
        { fill: "/sessions switch ", desc: "Switch to existing session" },
        { fill: "/sessions delete ", desc: "Delete a session" },
    ],
    "/memory": [
        { fill: "/memory", desc: "Show session & global memory" },
        { fill: "/memory add ", desc: "Pin fact to current session" },
        { fill: "/memory clear", desc: "Clear current session memory" },
        { fill: "/memory global add ", desc: "Add shared global memory" },
        { fill: "/memory global rm ", desc: "Remove global memory item" },
        { fill: "/memory global clear", desc: "Clear all global memory" },
    ],
    "/set": [
        { fill: "/set agentMode ", desc: "default | accept-edits | plan | auto" },
        { fill: "/set toolPermission ", desc: "ask | allow-reads | allow-edits | always-proceed" },
        { fill: "/set nonWorkspaceAccess ", desc: "ask | allow | deny" },
        { fill: "/set toolsEnabled ", desc: "true | false" },
        { fill: "/set autoSummarize ", desc: "true | false" },
        { fill: "/set maxToolSteps ", desc: "integer 1-100 (default 25)" },
        { fill: "/set maxHistoryMessages ", desc: "integer 2-500 (default 24)" },
        { fill: "/set contextWindow ", desc: "integer >= 1024 (default 128000)" },
        { fill: "/set temperature ", desc: "0.0-2.0 | null" },
        { fill: "/set maxTokens ", desc: "integer >= 1 | null" },
        { fill: "/set verbosity ", desc: "low | normal | high" },
        { fill: "/set language ", desc: "banglish | bangla | english" },
        { fill: "/set renderingMode ", desc: "fullscreen | inline" },
        { fill: "/set queuedMessages ", desc: "queue | interrupt" },
        { fill: "/set colorScheme ", desc: "amber | dark | light | terminal" },
    ],
};

function getSlashSuggestions(buffer) {
    if (!buffer.startsWith("/")) return [];
    const spaceIdx = buffer.indexOf(" ");
    if (spaceIdx === -1) {
        return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(buffer))
            .slice(0, 8)
            .map((c) => ({
                label: c.cmd,
                fill: c.hasArg ? `${c.cmd} ` : c.cmd,
                desc: c.desc,
            }));
    }
    const base = buffer.slice(0, spaceIdx);
    const subHints = SUBCOMMAND_HINTS[base];
    if (!subHints) return [];
    return subHints
        .filter((h) => h.fill.startsWith(buffer))
        .slice(0, 8)
        .map((h) => ({ label: h.fill.trimEnd(), fill: h.fill, desc: h.desc }));
}

function resolveSlashEnter(input, selIdx = 0) {
    const suggestions = getSlashSuggestions(input);
    if (!suggestions.length) return { action: "submit", value: input.trim() };
    const active = suggestions[selIdx] || suggestions[0];
    if (input.trim() === active.label) {
        return { action: "submit", value: active.label };
    }
    if (active.fill.endsWith(" ")) {
        return { action: "fill", value: active.fill };
    }
    return { action: "submit", value: active.fill.trim() };
}

function clearSuggestionsBelow(rows) {
    if (!rows) return;
    let seq = "";
    for (let i = 0; i < rows; i++) seq += "\n\x1b[K";
    seq += `\x1b[${rows}A`;
    process.stdout.write(seq);
}

// Reads a line in raw TTY mode with live /command suggestions and grapheme-safe editing.
function promptLine(promptLabel, history = []) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return new Promise((resolve) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(promptLabel, (ans) => {
                rl.close();
                resolve(ans);
            });
        });
    }

    return new Promise((resolve) => {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isPaused()) process.stdin.resume();
        process.stdin.setRawMode(true);

        const promptWidth = displayWidth(promptLabel);
        let buffer = "";
        let cursor = 0;
        let selIdx = 0;
        let histIdx = history.length;
        let prevRows = 0;

        const render = () => {
            if (prevRows) clearSuggestionsBelow(prevRows);
            process.stdout.write(`\r\x1b[K${promptLabel}${buffer}`);

            const suggestions = getSlashSuggestions(buffer);
            if (selIdx >= suggestions.length) selIdx = 0;

            if (suggestions.length) {
                let block = "";
                for (let i = 0; i < suggestions.length; i++) {
                    const s = suggestions[i];
                    const active = i === selIdx;
                    const line = active
                        ? `  ${C.bgSel} ${s.label.padEnd(22)} ${s.desc} ${C.reset}`
                        : `  ${C.cyan}${s.label.padEnd(22)}${C.reset} ${C.dim}${s.desc}${C.reset}`;
                    block += `\n\x1b[K${line}`;
                }
                block += `\x1b[${suggestions.length}A`;
                process.stdout.write(block);
            }
            prevRows = suggestions.length;

            const col = promptWidth + displayWidth(buffer.slice(0, cursor));
            process.stdout.write(col > 0 ? `\r\x1b[${col}C` : "\r");
        };

        const cleanup = () => {
            process.stdin.removeListener("keypress", onKey);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
        };

        const finish = (value) => {
            if (prevRows) clearSuggestionsBelow(prevRows);
            prevRows = 0;
            process.stdout.write(`\r\x1b[K${promptLabel}${buffer}\n`);
            cleanup();
            resolve(value);
        };

        const onKey = (str, key = {}) => {
            if (key.ctrl && key.name === "c") {
                if (prevRows) clearSuggestionsBelow(prevRows);
                process.stdout.write("\n");
                cleanup();
                resolve(null);
                return;
            }
            if (key.ctrl && key.name === "d" && !buffer.length) {
                finish(null);
                return;
            }
            if (key.name === "escape") {
                if (buffer.length) {
                    buffer = "";
                    cursor = 0;
                    selIdx = 0;
                    render();
                }
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                const res = resolveSlashEnter(buffer, selIdx);
                if (res.action === "fill") {
                    buffer = res.value;
                    cursor = buffer.length;
                    selIdx = 0;
                    render();
                    return;
                }
                buffer = res.value;
                finish(res.value);
                return;
            }
            if (key.name === "tab") {
                const suggestions = getSlashSuggestions(buffer);
                if (suggestions.length) {
                    buffer = suggestions[selIdx].fill;
                    cursor = buffer.length;
                    selIdx = 0;
                    render();
                }
                return;
            }
            if (key.name === "up") {
                const suggestions = getSlashSuggestions(buffer);
                if (suggestions.length) {
                    selIdx = (selIdx - 1 + suggestions.length) % suggestions.length;
                } else if (history.length && histIdx > 0) {
                    histIdx--;
                    buffer = history[histIdx];
                    cursor = buffer.length;
                }
                render();
                return;
            }
            if (key.name === "down") {
                const suggestions = getSlashSuggestions(buffer);
                if (suggestions.length) {
                    selIdx = (selIdx + 1) % suggestions.length;
                } else if (histIdx < history.length) {
                    histIdx++;
                    buffer = histIdx < history.length ? history[histIdx] : "";
                    cursor = buffer.length;
                }
                render();
                return;
            }
            if (key.name === "left") {
                cursor = prevGraphemeBoundary(buffer, cursor);
                render();
                return;
            }
            if (key.name === "right") {
                cursor = nextGraphemeBoundary(buffer, cursor);
                render();
                return;
            }
            if (key.name === "home" || (key.ctrl && key.name === "a")) {
                cursor = 0;
                render();
                return;
            }
            if (key.name === "end" || (key.ctrl && key.name === "e")) {
                cursor = buffer.length;
                render();
                return;
            }
            if (key.name === "backspace") {
                if (cursor > 0) {
                    const prev = prevGraphemeBoundary(buffer, cursor);
                    buffer = buffer.slice(0, prev) + buffer.slice(cursor);
                    cursor = prev;
                    selIdx = 0;
                    render();
                }
                return;
            }
            if (key.name === "delete") {
                if (cursor < buffer.length) {
                    const next = nextGraphemeBoundary(buffer, cursor);
                    buffer = buffer.slice(0, cursor) + buffer.slice(next);
                    selIdx = 0;
                    render();
                }
                return;
            }
            if (key.ctrl && key.name === "u") {
                buffer = "";
                cursor = 0;
                selIdx = 0;
                render();
                return;
            }
            if (str && !key.ctrl && !key.meta && str >= " ") {
                buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
                cursor += str.length;
                selIdx = 0;
                render();
            }
        };

        process.stdin.on("keypress", onKey);
        render();
    });
}

function promptSecret(label) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve("");
    return new Promise((resolve) => {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isPaused()) process.stdin.resume();
        process.stdin.setRawMode(true);
        process.stdout.write(label);

        let secret = "";
        const cleanup = () => {
            process.stdin.removeListener("keypress", onKey);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
        };
        const onKey = (str, key = {}) => {
            if (key.ctrl && key.name === "c") {
                process.stdout.write("\n");
                cleanup();
                resolve("");
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                process.stdout.write("\n");
                cleanup();
                resolve(secret);
                return;
            }
            if (key.name === "backspace") {
                if (secret.length) {
                    const prev = prevGraphemeBoundary(secret, secret.length);
                    secret = secret.slice(0, prev);
                    process.stdout.write("\b \b");
                }
                return;
            }
            if (str && !key.ctrl && !key.meta && str >= " ") {
                secret += str;
                process.stdout.write("*");
            }
        };
        process.stdin.on("keypress", onKey);
    });
}

function promptConfirm(label) {
    if (!process.stdin.isTTY) return Promise.resolve("n");
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(label, (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase());
        });
    });
}

module.exports = {
    C,
    SLASH_COMMANDS,
    SUBCOMMAND_HINTS,
    stripAnsi,
    getSlashSuggestions,
    resolveSlashEnter,
    promptLine,
    promptSecret,
    promptConfirm,
};
