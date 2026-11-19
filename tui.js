"use strict";

const readline = require("node:readline");
const { PassThrough } = require("node:stream");
const { getSlashSuggestions, resolveSlashEnter } = require("./ui");
const { walkWorkspace } = require("./src/tools/fs_walk");
const { CONTROL_SEQ, getPalette } = require("./src/tui/themes");
const {
    stripAnsi,
    displayWidth,
    segmentGraphemes,
    prevGraphemeBoundary,
    nextGraphemeBoundary,
    wrapPlain,
    clipToWidth,
    padRight,
    sliceByVisualColumns,
} = require("./src/tui/text_width");
const {
    getFilteredSettings,
    getFilteredPermissions,
    renderSettingsScreen,
    renderPermissionsScreen,
    stepSettingValue,
    parseSettingValue,
} = require("./src/tui/settings_panel");

function copyToClipboardOsc52(text, stdout = process.stdout) {
    if (!text) return false;
    const b64 = Buffer.from(text, "utf8").toString("base64");
    stdout.write(`\x1b]52;c;${b64}\x07`);
    return true;
}

function styleInlineMarkdown(line, ansi) {
    return line
        .replace(/`([^`]+)`/g, `${ansi.amber}$1${ansi.reset}${ansi.white}`)
        .replace(/\*\*([^*]+)\*\*/g, `${ansi.bold}${ansi.amber}$1${ansi.reset}${ansi.white}`);
}

function formatAssistantLines(text, innerW, ansi) {
    const out = [];
    const rawLines = String(text || "").split(/\r?\n/);
    let inCode = false;

    for (const raw of rawLines) {
        const fence = raw.match(/^\s*```(.*)$/);
        if (fence) {
            inCode = !inCode;
            const lang = fence[1].trim();
            out.push(
                inCode
                    ? `  ${ansi.gray}┌─${lang ? ` ${lang} ` : ""}${"─".repeat(Math.max(4, Math.min(36, innerW - 6 - lang.length)))}${ansi.reset}`
                    : `  ${ansi.gray}└${"─".repeat(Math.max(6, Math.min(38, innerW - 4)))}${ansi.reset}`
            );
            continue;
        }
        if (inCode) {
            for (const wl of wrapPlain(raw, innerW - 4)) {
                out.push(`  ${ansi.gray}│ ${ansi.amber}${wl}${ansi.reset}`);
            }
            continue;
        }
        const heading = raw.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
            for (const wl of wrapPlain(heading[2], innerW - 4)) {
                out.push(`  ${ansi.orange}┃ ${ansi.bold}${ansi.amber}${wl}${ansi.reset}`);
            }
            continue;
        }
        const bullet = raw.match(/^(\s*)[-*]\s+(.*)$/);
        const normalized = bullet ? `${bullet[1]}• ${bullet[2]}` : raw;
        for (const wl of wrapPlain(normalized, innerW - 4)) {
            out.push(`  ${ansi.orange}┃ ${ansi.white}${styleInlineMarkdown(wl, ansi)}${ansi.reset}`);
        }
    }
    return out;
}

/**
 * Lay out multi-line composer buffer with exact cursor visual row/col on grapheme boundaries.
 */
function layoutComposer(text, cursorPos, availW) {
    const w = Math.max(8, availW);
    const lines = [];
    let curRow = 0;
    let curCol = 0;
    let pos = 0;
    const rawParts = String(text || "").split("\n");

    for (let p = 0; p < rawParts.length; p++) {
        const part = rawParts[p];
        if (!part.length) {
            if (cursorPos === pos) {
                curRow = lines.length;
                curCol = 0;
            }
            lines.push("");
            pos += 1;
            continue;
        }

        const graphemes = segmentGraphemes(part);
        let gStart = 0;
        while (gStart < graphemes.length) {
            let lineW = 0;
            let gEnd = gStart;
            while (gEnd < graphemes.length) {
                const gw = graphemes[gEnd].width;
                if (lineW + gw > w && gEnd > gStart) break;
                lineW += gw;
                gEnd += 1;
            }

            const sliceStartChar = graphemes[gStart].index;
            const sliceEndChar = gEnd < graphemes.length ? graphemes[gEnd].index : part.length;
            const slice = part.slice(sliceStartChar, sliceEndChar);
            const startAbs = pos + sliceStartChar;
            const endAbs = pos + sliceEndChar;

            if (cursorPos >= startAbs && cursorPos <= endAbs) {
                curRow = lines.length;
                curCol = cursorPos - startAbs;
            }
            lines.push(slice);
            gStart = gEnd;
        }
        pos += part.length + 1;
    }
    if (!lines.length) lines.push("");
    return { lines, curRow, curCol };
}

class KovenceTUI {
    constructor({
        onSubmit,
        onCancel,
        onExit,
        onOpenSessions,
        onNewSession,
        onCycleMode,
        onUpdateSetting,
        onGetSettings,
        onGetProviders,
        onGetModels = null,
        onRefreshModels = null,
        onPickSettingChoice = null,
        onGetPermissionRules,
        onRemovePermissionRule,
        workspaceRoot = process.cwd(),
        initialInputHistory = [],
        onSaveInputHistory = null,
        stdout = process.stdout,
        stdin = process.stdin,
    }) {
        this.onSubmit = onSubmit;
        this.onCancel = onCancel;
        this.onExit = onExit;
        this.onOpenSessions = onOpenSessions;
        this.onNewSession = onNewSession;
        this.onCycleMode = onCycleMode;
        this.onUpdateSetting = onUpdateSetting;
        this.onGetSettings = onGetSettings;
        this.onGetProviders = onGetProviders;
        this.onGetModels = onGetModels;
        this.onRefreshModels = onRefreshModels;
        this.onPickSettingChoice = onPickSettingChoice;
        this.onGetPermissionRules = onGetPermissionRules;
        this.onRemovePermissionRule = onRemovePermissionRule;
        this.workspaceRoot = workspaceRoot;
        this.onSaveInputHistory = onSaveInputHistory;
        this.stdout = stdout;
        this.stdin = stdin;

        this.blocks = [];
        this.input = "";
        this.cursor = 0;
        this.selIdx = 0;
        this.inputHistory = Array.isArray(initialInputHistory) ? [...initialInputHistory] : [];
        this.histIdx = this.inputHistory.length;
        this._fileCache = { ts: 0, files: [] };
        this.scrollOffset = 0;
        this.lastTotalLines = 0;

        this.modal = null;
        this.picker = null;
        this.settingsScreen = null;
        this.permScreen = null;

        this.mouseTracking = true;
        this.isSelecting = false;
        this.selStart = null;
        this.selEnd = null;
        this.lastViewState = { startIdx: 0, viewHeight: 10, plainLines: [] };
        this.noticeTimer = null;
        this.lastCtrlCAt = 0;

        this.status = {
            sessionId: "default",
            provider: "default",
            providerType: "openai",
            model: "",
            ctxText: "",
            agentMode: "default",
            colorScheme: "amber",
            tools: true,
            auto: false,
            showTips: true,
            showActiveTasks: true,
            activeBgTasks: 0,
            activeTodos: 0,
            notifications: true,
            isBusy: false,
            queueLen: 0,
            busyLabel: "",
            notice: "",
        };

        this.active = false;
        this.renderPending = false;
        this.rawBuf = "";
        this.keyStream = null;
        this.onKey = this.onKey.bind(this);
        this.onRawData = this.onRawData.bind(this);
        this.onResize = () => this.scheduleRender();
    }

    getPalette() {
        return getPalette(this.status.colorScheme || "amber");
    }

    flashNotice(msg, ms = 2500) {
        this.status.notice = msg;
        if (this.noticeTimer) clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => {
            this.status.notice = "";
            this.scheduleRender();
        }, ms);
        this.noticeTimer.unref?.();
        this.scheduleRender();
    }

    toggleMouseMode() {
        this.mouseTracking = !this.mouseTracking;
        if (this.active) {
            this.stdout.write(this.mouseTracking ? CONTROL_SEQ.mouseOn : CONTROL_SEQ.mouseOff);
        }
        this.flashNotice(
            this.mouseTracking ? "Scroll/Select mode ON" : "Native terminal select ON (F2 to restore scroll)",
            3000
        );
    }

    copyLastResponse() {
        const lastAi = [...this.blocks].reverse().find((b) => b.kind === "assistant" && b.text.trim());
        if (!lastAi) {
            this.flashNotice("No AI response to copy yet");
            return false;
        }
        copyToClipboardOsc52(lastAi.text, this.stdout);
        this.flashNotice(`Copied last response (${lastAi.text.length} chars)`);
        return true;
    }

    insertNewline() {
        this.input = this.input.slice(0, this.cursor) + "\n" + this.input.slice(this.cursor);
        this.cursor += 1;
        this.selIdx = 0;
        this.scheduleRender();
    }

    setInput(text) {
        this.input = String(text || "");
        this.cursor = this.input.length;
        this.selIdx = 0;
        this.scheduleRender();
    }

    removeQueuedBlocks() {
        this.blocks = this.blocks.filter((b) => b.kind !== "queued");
        this.scheduleRender();
    }

    openSettings() {
        if (this.modal || this.picker) return;
        this.permScreen = null;
        this.settingsScreen = {
            search: "",
            selIdx: 0,
            editing: null,
            editError: "",
        };
        this.onRefreshModels?.();
        this.scheduleRender();
    }

    openManagePermissions() {
        this.permScreen = {
            search: "",
            selIdx: 0,
            notice: "",
        };
        this.scheduleRender();
    }

    getNormalizedSelection() {
        if (!this.selStart || !this.selEnd) return null;
        const a = this.selStart;
        const b = this.selEnd;
        if (a.absLine < b.absLine || (a.absLine === b.absLine && a.col <= b.col)) {
            return { start: a, end: b };
        }
        return { start: b, end: a };
    }

    extractSelectedText() {
        const norm = this.getNormalizedSelection();
        if (!norm) return "";
        const { plainLines } = this.lastViewState;
        const out = [];
        for (let ln = norm.start.absLine; ln <= norm.end.absLine; ln++) {
            const line = (plainLines[ln] || "").trimEnd();
            const c1 = ln === norm.start.absLine ? norm.start.col : 0;
            const c2 = ln === norm.end.absLine ? norm.end.col + 1 : displayWidth(line);
            const sliced = sliceByVisualColumns(line, c1, Math.max(c1, c2));
            out.push(sliced.selected);
        }
        return out.join("\n").trim();
    }

    handleMouseEvent(btn, x, y, kind) {
        if (this.settingsScreen || this.permScreen) return;
        if (btn === 64) {
            this.scrollOffset += 3;
            this.scheduleRender();
            return;
        }
        if (btn === 65) {
            this.scrollOffset = Math.max(0, this.scrollOffset - 3);
            this.scheduleRender();
            return;
        }
        const headerRows = 2;
        const vRow = y - (headerRows + 1);
        const { startIdx, viewHeight, plainLines } = this.lastViewState;
        const clampedRow = Math.max(0, Math.min(viewHeight - 1, vRow));
        const absLine = Math.max(0, Math.min(plainLines.length - 1, startIdx + clampedRow));
        const col = Math.max(0, x - 1);

        if (btn === 0 && kind === "M") {
            if (vRow >= 0 && vRow < viewHeight && plainLines.length) {
                this.isSelecting = true;
                this.selStart = { absLine, col };
                this.selEnd = { absLine, col };
            } else {
                this.isSelecting = false;
                this.selStart = null;
                this.selEnd = null;
            }
            this.scheduleRender();
            return;
        }
        if ((btn === 32 || btn === 33) && kind === "M" && this.isSelecting) {
            this.selEnd = { absLine, col };
            this.scheduleRender();
            return;
        }
        if ((btn === 0 || btn === 3) && kind === "m" && this.isSelecting) {
            this.isSelecting = false;
            const isSingleClick =
                this.selStart &&
                this.selEnd &&
                this.selStart.absLine === this.selEnd.absLine &&
                Math.abs(this.selStart.col - this.selEnd.col) <= 1;
            if (isSingleClick) {
                const clickedBlock = this.lastViewState.lineBlocks?.[this.selStart.absLine];
                if (clickedBlock && clickedBlock.collapsible) {
                    this.selStart = null;
                    this.selEnd = null;
                    this.toggleBlockExpanded(clickedBlock);
                    return;
                }
            }
            const text = this.extractSelectedText();
            if (text) {
                copyToClipboardOsc52(text, this.stdout);
                this.flashNotice(`Copied ${text.length} chars to clipboard`);
            }
            this.scheduleRender();
        }
    }

    onRawData(chunk) {
        this.rawBuf += chunk.toString("utf8");
        let out = "";
        let i = 0;
        while (i < this.rawBuf.length) {
            if (this.rawBuf[i] === "\x1b") {
                const rest = this.rawBuf.slice(i);
                // Ctrl+, via Kitty / modifyOtherKeys / Alt+, -> open settings
                const ctrlComma = rest.match(/^(?:\x1b\[44;5u|\x1b\[27;5;44~|\x1b,)/);
                if (ctrlComma) {
                    this.openSettings();
                    i += ctrlComma[0].length;
                    continue;
                }
                // Shift+Enter / Alt+Enter sequences -> emit '\n' in order to keyStream (preserved intact)
                const shiftEnter = rest.match(/^(?:\x1b\[13;2u|\x1b\[27;2;13~|\x1b\r)/);
                if (shiftEnter) {
                    out += "\n";
                    i += shiftEnter[0].length;
                    continue;
                }
                // Kitty CSI-u (\x1b[code;modu) and xterm modifyOtherKeys (\x1b[27;mod;code~) normalization
                // Ensures Ctrl+C, Ctrl+D, Esc, Shift+Tab, Ctrl+S/N/Y/U work in VS Code, Kitty, WezTerm, Ghostty, etc.
                const csiU = rest.match(/^\x1b\[(\d+)(?:;(\d+)(?::\d+)?)?u/);
                const modOther = !csiU ? rest.match(/^\x1b\[27;(\d+);(\d+)~/) : null;
                if (csiU || modOther) {
                    const rawSeq = csiU ? csiU[0] : modOther[0];
                    const cp = Number(csiU ? csiU[1] : modOther[2]);
                    const mod = Math.max(0, (Number(csiU ? csiU[2] || 1 : modOther[1]) || 1) - 1);
                    const shift = Boolean(mod & 1);
                    const alt = Boolean(mod & 2);
                    const ctrl = Boolean(mod & 4);

                    if (cp === 13 && (shift || alt)) {
                        out += "\n";
                    } else if (cp === 13 && !ctrl) {
                        out += "\r";
                    } else if (cp === 27 && !ctrl) {
                        if (out && this.keyStream) {
                            this.keyStream.write(out);
                            out = "";
                        }
                        this.onKey("", { name: "escape", sequence: "\x1b" });
                    } else if (cp === 9 && shift && !ctrl) {
                        out += "\x1b[Z";
                    } else if (cp === 9 && !ctrl) {
                        out += "\t";
                    } else if ((cp === 127 || cp === 8) && !ctrl) {
                        out += "\x7f";
                    } else if (ctrl && cp >= 97 && cp <= 122) {
                        out += String.fromCharCode(cp - 96);
                    } else if (ctrl && cp >= 65 && cp <= 90) {
                        out += String.fromCharCode(cp - 64);
                    } else if (ctrl && cp === 44) {
                        this.openSettings();
                    } else if (!ctrl && !alt && cp >= 32 && cp <= 0x10ffff) {
                        out += String.fromCodePoint(cp);
                    }
                    i += rawSeq.length;
                    continue;
                }
                // Wait for incomplete CSI-u / modifyOtherKeys sequence split across chunks
                if (/^\x1b\[[\d;:]*$/.test(rest) && rest.length < 18) {
                    break;
                }
                // SGR mouse sequence: \x1b[<btn;x;y[mM]
                const sgr = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])/);
                if (sgr) {
                    this.handleMouseEvent(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4]);
                    i += sgr[0].length;
                    continue;
                }
                if (/^\x1b\[<[\d;]*$/.test(rest) && rest.length < 24) {
                    break;
                }
                // Legacy X10 mouse packet
                if (rest.startsWith("\x1b[M")) {
                    if (rest.length < 6) break;
                    const cb = rest.charCodeAt(3) - 32;
                    if (cb === 64) {
                        this.scrollOffset += 3;
                        this.scheduleRender();
                    } else if (cb === 65) {
                        this.scrollOffset = Math.max(0, this.scrollOffset - 3);
                        this.scheduleRender();
                    }
                    i += 6;
                    continue;
                }
                // Standalone Esc byte at end of chunk: wait briefly in case an escape sequence was split across chunks
                if (rest === "\x1b") {
                    if (this.escTimer) clearTimeout(this.escTimer);
                    this.escTimer = setTimeout(() => {
                        this.escTimer = null;
                        if (this.rawBuf === "\x1b") {
                            this.rawBuf = "";
                            this.onKey("", { name: "escape", sequence: "\x1b" });
                        }
                    }, 25);
                    this.escTimer.unref?.();
                    break;
                }
            }
            out += this.rawBuf[i];
            i++;
        }
        this.rawBuf = this.rawBuf.slice(i);
        if (this.rawBuf !== "\x1b" && this.escTimer) {
            clearTimeout(this.escTimer);
            this.escTimer = null;
        }
        if (out && this.keyStream) this.keyStream.write(out);
    }

    enter() {
        if (this.active) return;
        this.active = true;
        this.stdout.write(CONTROL_SEQ.altOn + (this.mouseTracking ? CONTROL_SEQ.mouseOn : "") + CONTROL_SEQ.keysOn);
        if (this.stdin.isTTY) {
            this.keyStream = new PassThrough();
            readline.emitKeypressEvents(this.keyStream);
            this.keyStream.on("keypress", this.onKey);
            if (this.stdin.isPaused()) this.stdin.resume();
            this.stdin.setRawMode(true);
            this.stdin.on("data", this.onRawData);
        }
        this.stdout.on("resize", this.onResize);
        this.render();
    }

    leave() {
        if (!this.active) return;
        this.active = false;
        if (this.noticeTimer) clearTimeout(this.noticeTimer);
        this.stdin.removeListener("data", this.onRawData);
        if (this.keyStream) {
            this.keyStream.removeListener("keypress", this.onKey);
            this.keyStream.destroy();
            this.keyStream = null;
        }
        this.stdout.removeListener("resize", this.onResize);
        if (this.stdin.isTTY) {
            try {
                this.stdin.setRawMode(false);
            } catch {}
        }
        this.stdout.write(CONTROL_SEQ.keysOff + CONTROL_SEQ.mouseOff + CONTROL_SEQ.showCur + CONTROL_SEQ.altOff);
    }

    setStatus(patch) {
        Object.assign(this.status, patch);
        this.scheduleRender();
    }

    addBlock(kind, text, opts = {}) {
        const block = {
            kind,
            text: String(text || ""),
            collapsible: Boolean(opts.collapsible),
            expanded: Boolean(opts.expanded),
            details: Array.isArray(opts.details) ? opts.details : [],
            statusLine: String(opts.statusLine || ""),
            _ver: 1,
            _cache: null,
        };
        this.blocks.push(block);
        this.scheduleRender();
        return block;
    }

    setBlockDetails(block, details, statusLine = undefined) {
        if (!block) return;
        if (Array.isArray(details)) block.details = details;
        if (statusLine !== undefined) block.statusLine = String(statusLine || "");
        block._ver = (block._ver || 0) + 1;
        block._cache = null;
        this.scheduleRender();
    }

    toggleBlockExpanded(block) {
        if (!block || !block.collapsible) return false;
        block.expanded = !block.expanded;
        block._ver = (block._ver || 0) + 1;
        block._cache = null;
        this.scheduleRender();
        return block.expanded;
    }

    toggleLastCollapsibleBlock() {
        const target = [...this.blocks].reverse().find((b) => b.collapsible);
        if (!target) return false;
        return this.toggleBlockExpanded(target);
    }

    updateBlock(block, text) {
        block.text = String(text || "");
        block._ver = (block._ver || 0) + 1;
        block._cache = null;
        this.scheduleRender();
    }

    appendBlock(block, chunk) {
        block.text += chunk;
        block._ver = (block._ver || 0) + 1;
        block._cache = null;
        this.scheduleRender();
    }

    clearBlocks() {
        this.blocks = [];
        this.scrollOffset = 0;
        this.lastTotalLines = 0;
        this.selStart = null;
        this.selEnd = null;
        this.scheduleRender();
    }

    askModal(label, masked = false) {
        return new Promise((resolve) => {
            this.modal = { label, masked, buf: "", resolve };
            this.scheduleRender();
        });
    }

    cancelModal() {
        if (!this.modal) return false;
        const { resolve } = this.modal;
        this.modal = null;
        this.scheduleRender();
        resolve("");
        return true;
    }

    openPicker(title, items, { initialIdx = 0, hint = "↑/↓ select · Enter open · d delete · Esc close" } = {}) {
        return new Promise((resolve) => {
            let safeIdx = Math.max(0, Math.min(Number(initialIdx) || 0, Math.max(0, items.length - 1)));
            if (items[safeIdx]?.type === "header") {
                const nextSelectable = items.findIndex((x) => x.type !== "header");
                if (nextSelectable >= 0) safeIdx = nextSelectable;
            }
            this.picker = { title, items, selIdx: safeIdx, hint, resolve };
            this.scheduleRender();
        });
    }

    scheduleRender() {
        if (!this.active || this.renderPending) return;
        this.renderPending = true;
        setImmediate(() => {
            this.renderPending = false;
            if (this.active) this.render();
        });
    }

    /**
     * Format & cache each viewport block keyed by (version, cols, colorScheme) for O(1) incremental redraws.
     */
    buildViewportLines(cols) {
        const ansi = this.getPalette();
        const scheme = this.status.colorScheme || "amber";
        const innerW = Math.max(20, cols - 4);
        const lines = [];
        const plainLines = [];
        const lineBlocks = [];

        for (const b of this.blocks) {
            const ver = b._ver || 1;
            const cacheKey = `${ver}:${cols}:${scheme}`;
            if (!b._cache || b._cache.key !== cacheKey) {
                const blockLines = [];
                if (b.kind === "brand-cyan") {
                    for (const rawLine of String(b.text || "").split(/\r?\n/)) {
                        blockLines.push(`${ansi.amber}${ansi.bold}${rawLine}${ansi.reset}`);
                    }
                } else if (b.kind === "brand-magenta") {
                    for (const rawLine of String(b.text || "").split(/\r?\n/)) {
                        blockLines.push(`${ansi.orange}${ansi.bold}${rawLine}${ansi.reset}`);
                    }
                } else {
                    const wrapped = wrapPlain(b.text, innerW);
                    if (b.kind === "user") {
                        blockLines.push("");
                        blockLines.push(
                            `${ansi.barBg}${ansi.cyan}${ansi.bold}┃ YOU${" ".repeat(Math.max(0, cols - 5))}${ansi.reset}`
                        );
                        for (const wl of wrapped) {
                            const w = displayWidth(wl);
                            blockLines.push(`${ansi.barBg}${ansi.cyan}┃ ${ansi.white}${padRight(wl, w, cols - 2)}${ansi.reset}`);
                        }
                        blockLines.push("");
                    } else if (b.kind === "assistant") {
                        blockLines.push(`  ${ansi.orange}${ansi.bold}◆ KOVENCE CLI${ansi.reset}`);
                        blockLines.push(...formatAssistantLines(b.text, innerW, ansi));
                    } else if (b.kind === "thinking") {
                        blockLines.push(`  ${ansi.orange}${ansi.bold}◆ KOVENCE CLI${ansi.reset}`);
                        for (const wl of wrapped) {
                            blockLines.push(`  ${ansi.orange}┃ ${ansi.amber}${wl}${ansi.reset}`);
                        }
                    } else if (b.kind === "tool") {
                        if (b.collapsible) {
                            const arrow = b.expanded ? "▾" : "▸";
                            const hint = b.expanded ? " (click to hide)" : " (click for live details)";
                            for (let i = 0; i < wrapped.length; i++) {
                                const wl = wrapped[i];
                                if (i === 0) {
                                    blockLines.push(
                                        `  ${ansi.gray}├─ ${ansi.amber}${arrow} ${wl}${ansi.reset}${ansi.dim}${ansi.gray}${hint}${ansi.reset}`
                                    );
                                } else {
                                    blockLines.push(`  ${ansi.gray}│    ${ansi.amber}${wl}${ansi.reset}`);
                                }
                            }
                            const detailW = Math.max(12, innerW - 6);
                            if (b.expanded) {
                                const visDetails = (b.details || []).slice(-16);
                                if (!visDetails.length) {
                                    const emptyMsg = b.statusLine || "… waiting for live command output …";
                                    blockLines.push(
                                        `  ${ansi.gray}│    ${ansi.dim}${ansi.gray}${clipToWidth(emptyMsg, detailW)}${ansi.reset}`
                                    );
                                } else {
                                    for (const dl of visDetails) {
                                        blockLines.push(
                                            `  ${ansi.gray}│    ${ansi.dim}${ansi.gray}${clipToWidth(dl, detailW)}${ansi.reset}`
                                        );
                                    }
                                }
                            } else if (b.statusLine) {
                                blockLines.push(
                                    `  ${ansi.gray}│    ${ansi.dim}${ansi.gray}${clipToWidth(b.statusLine, detailW)}${ansi.reset}`
                                );
                            }
                        } else {
                            for (const wl of wrapped) {
                                blockLines.push(`  ${ansi.gray}├─ ${ansi.amber}${wl}${ansi.reset}`);
                            }
                        }
                    } else if (b.kind === "meta") {
                        for (const wl of wrapped) {
                            blockLines.push(`  ${ansi.gray}└─ ${wl}${ansi.reset}`);
                        }
                        if (b.text.includes("memory")) {
                            blockLines.push(`  ${ansi.gray}${"─".repeat(Math.min(56, innerW))}${ansi.reset}`);
                        }
                    } else if (b.kind === "queued") {
                        for (const wl of wrapped) {
                            blockLines.push(`  ${ansi.magenta}⏳ ${wl}${ansi.reset}`);
                        }
                    } else if (b.kind === "permission") {
                        blockLines.push("");
                        for (let i = 0; i < wrapped.length; i++) {
                            const wl = wrapped[i];
                            const color = i === 0 ? `${ansi.bold}${ansi.amber}` : ansi.white;
                            blockLines.push(`  ${ansi.orange}┃ ${color}${wl}${ansi.reset}`);
                        }
                    } else if (b.kind === "error") {
                        for (const wl of wrapped) {
                            blockLines.push(`  ${ansi.red}✖ ${wl}${ansi.reset}`);
                        }
                        blockLines.push("");
                    } else {
                        for (const wl of wrapped) {
                            blockLines.push(`  ${ansi.dim}${wl}${ansi.reset}`);
                        }
                    }
                }
                b._cache = {
                    key: cacheKey,
                    lines: blockLines,
                    plainLines: blockLines.map(stripAnsi),
                };
            }
            for (let i = 0; i < b._cache.lines.length; i++) {
                lines.push(b._cache.lines[i]);
                plainLines.push(b._cache.plainLines[i]);
                lineBlocks.push(b);
            }
        }
        return { lines, plainLines, lineBlocks };
    }

    render() {
        const cols = this.stdout.columns || 100;
        const rows = this.stdout.rows || 30;
        const ansi = this.getPalette();

        if (this.permScreen) {
            const rules = this.onGetPermissionRules ? this.onGetPermissionRules() : [];
            const frame = renderPermissionsScreen({
                cols,
                rows,
                permState: this.permScreen,
                rules,
                ansi,
            });
            this.stdout.write(CONTROL_SEQ.syncStart + frame + CONTROL_SEQ.syncEnd);
            return;
        }

        if (this.settingsScreen) {
            const settings = this.onGetSettings ? this.onGetSettings() : {};
            const frame = renderSettingsScreen({
                cols,
                rows,
                settingsState: this.settingsScreen,
                settings,
                ansi,
            });
            this.stdout.write(CONTROL_SEQ.syncStart + frame + CONTROL_SEQ.syncEnd);
            return;
        }

        const suggestions = this.modal || this.picker ? [] : this._getActiveSuggestions();
        if (this.selIdx >= suggestions.length) this.selIdx = 0;

        const promptPrefix = "> ";
        let displayBuf = this.input;
        let cursorPos = this.cursor;
        let modalLines = [];
        if (this.modal) {
            modalLines = wrapPlain(this.modal.label, Math.max(12, cols - 4));
            displayBuf = this.modal.masked ? "*".repeat(this.modal.buf.length) : this.modal.buf;
            cursorPos = displayBuf.length;
        }
        const availW = Math.max(8, cols - 3 - displayWidth(promptPrefix));
        const compLayout = layoutComposer(displayBuf, cursorPos, availW);
        const maxCompLines = 6;
        let compStart = 0;
        if (compLayout.curRow >= maxCompLines) compStart = compLayout.curRow - maxCompLines + 1;
        const visCompLines = compLayout.lines.slice(compStart, compStart + maxCompLines);

        const pickerRows = this.picker ? Math.min(10, this.picker.items.length) + 2 : 0;
        const sugRows = suggestions.length;
        const composerRows = 3 + modalLines.length + visCompLines.length;
        const headerRows = 2;
        const viewHeight = Math.max(4, rows - headerRows - sugRows - pickerRows - composerRows);

        const { lines: allViewLines, plainLines, lineBlocks } = this.buildViewportLines(cols);
        // Scroll anchoring (B24): when scrolled up reading history, keep viewport anchored during streaming updates.
        if (this.scrollOffset > 0 && allViewLines.length > this.lastTotalLines) {
            this.scrollOffset += allViewLines.length - this.lastTotalLines;
        }
        this.lastTotalLines = allViewLines.length;

        const maxScroll = Math.max(0, allViewLines.length - viewHeight);
        if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
        const endIdx = allViewLines.length - this.scrollOffset;
        const startIdx = Math.max(0, endIdx - viewHeight);
        this.lastViewState = { startIdx, viewHeight, plainLines, lineBlocks };

        const normSel = this.getNormalizedSelection();
        const out = [ansi.hideCur, "\x1b[H"];

        // 1) Top Brand Header
        const qText = this.status.queueLen ? `Queue: ${this.status.queueLen} ` : "";
        const bText = this.status.notice ? `${this.status.notice} ` : this.status.busyLabel ? `${this.status.busyLabel} ` : "";
        const rightPlain = `${qText}${bText}`;
        const maxLeftHdr = Math.max(12, cols - displayWidth(rightPlain) - 1);
        const rawLeftHdr = ` KOVENCE CLI · https://kovence.com · [${this.status.sessionId}]`;
        const leftHdr = clipToWidth(rawLeftHdr, maxLeftHdr);
        const gapHdr = Math.max(1, cols - displayWidth(leftHdr) - displayWidth(rightPlain));
        const hdrPrefix = ` KOVENCE CLI`;
        const hdrRest = leftHdr.startsWith(hdrPrefix) ? leftHdr.slice(hdrPrefix.length) : leftHdr;
        const hdrBrand = leftHdr.startsWith(hdrPrefix)
            ? `${ansi.topBg}${ansi.orange}${ansi.bold}${hdrPrefix}${ansi.reset}${ansi.topBg}${ansi.gray}${hdrRest}`
            : `${ansi.topBg}${ansi.orange}${ansi.bold}${leftHdr}`;
        out.push(
            `${hdrBrand}${" ".repeat(gapHdr)}${ansi.amber}${qText}${this.status.notice ? ansi.green : ansi.orange}${bText}${ansi.reset}\x1b[K\n`
        );
        out.push(`${ansi.gray}${"─".repeat(cols)}${ansi.reset}\x1b[K\n`);

        // 2) Scrollable Output Viewport
        for (let i = 0; i < viewHeight; i++) {
            const absIdx = startIdx + i;
            let line = allViewLines[absIdx] || "";
            if (normSel && absIdx >= normSel.start.absLine && absIdx <= normSel.end.absLine && absIdx < plainLines.length) {
                const pl = plainLines[absIdx];
                const plW = displayWidth(pl);
                const c1 = absIdx === normSel.start.absLine ? Math.min(plW, normSel.start.col) : 0;
                const c2 = absIdx === normSel.end.absLine ? Math.min(plW, normSel.end.col + 1) : plW;
                if (c2 > c1) {
                    const seg = sliceByVisualColumns(pl, c1, c2);
                    line = `${seg.before}${ansi.selBg}${seg.selected}${ansi.reset}${seg.after}`;
                }
            }
            out.push(`${line}\x1b[K\n`);
        }

        // 3) Floating Session Picker OR Slash Suggestions
        if (this.picker) {
            const maxVisible = Math.min(10, this.picker.items.length);
            const pStart = Math.max(
                0,
                Math.min(this.picker.selIdx - Math.floor(maxVisible / 2), this.picker.items.length - maxVisible)
            );
            const hintText = this.picker.hint || "↑/↓ select · Enter open · d delete · Esc close";
            const titleText = clipToWidth(` ${this.picker.title} · ${hintText}`, cols);
            out.push(`${ansi.topBg}${ansi.orange}${ansi.bold}${padRight(titleText, displayWidth(titleText), cols)}${ansi.reset}\x1b[K\n`);
            for (let i = 0; i < maxVisible; i++) {
                const idx = pStart + i;
                const it = this.picker.items[idx];
                if (it.type === "header") {
                    const hdrText = clipToWidth(` ── ${it.label} ── ${it.desc || ""}`, cols);
                    out.push(`${ansi.barBg}${ansi.orange}${ansi.bold}${padRight(hdrText, displayWidth(hdrText), cols)}${ansi.reset}\x1b[K\n`);
                    continue;
                }
                const active = idx === this.picker.selIdx;
                const left = clipToWidth(` ${it.label.padEnd(22)}`, Math.min(24, cols));
                const right = clipToWidth(it.desc || "", Math.max(0, cols - displayWidth(left) - 1));
                const plainLen = displayWidth(left) + 1 + displayWidth(right);
                const line = active
                    ? `${ansi.selBg}${padRight(`${left} ${right}`, plainLen, cols)}${ansi.reset}`
                    : `${ansi.barBg}${it.type === "new" ? ansi.green : ansi.amber}${left} ${ansi.gray}${padRight(right, plainLen, cols)}${ansi.reset}`;
                out.push(`${line}\x1b[K\n`);
            }
            out.push(`${ansi.gray}${"─".repeat(cols)}${ansi.reset}\x1b[K\n`);
        }

        for (let i = 0; i < sugRows; i++) {
            const s = suggestions[i];
            const active = i === this.selIdx;
            const labelCol = ` ${s.label.padEnd(22)}`;
            const descCol = clipToWidth(s.desc, Math.max(0, cols - displayWidth(labelCol) - 1));
            const text = `${labelCol} ${descCol}`;
            const line = active
                ? `${ansi.selBg}${padRight(text, displayWidth(text), cols)}${ansi.reset}`
                : `${ansi.barBg}${ansi.orange}${labelCol}${ansi.gray} ${padRight(descCol, displayWidth(text), cols)}${ansi.reset}`;
            out.push(`${line}\x1b[K\n`);
        }

        // 4) Multi-Line Bottom Composer Box
        const boxPad = `${ansi.barBg}${ansi.orange}┃${" ".repeat(Math.max(0, cols - 1))}${ansi.reset}\x1b[K\n`;
        out.push(boxPad);

        for (const ml of modalLines) {
            const clippedModal = clipToWidth(ml, Math.max(8, cols - 3));
            const mw = displayWidth(clippedModal);
            out.push(`${ansi.barBg}${ansi.orange}┃ ${ansi.amber}${padRight(clippedModal, mw, cols - 2)}${ansi.reset}\x1b[K\n`);
        }

        const prefixSpace = " ".repeat(displayWidth(promptPrefix));
        for (let i = 0; i < visCompLines.length; i++) {
            const pfx = i === 0 && compStart === 0 ? promptPrefix : prefixSpace;
            const txt = visCompLines[i];
            const showPh =
                i === 0 &&
                compStart === 0 &&
                !this.modal &&
                !this.input &&
                this.status.showTips !== false &&
                cols >= 2 + displayWidth(pfx) + 52;
            const phText = "Type message · Shift+Enter newline · / commands...";
            const placeholder = showPh ? `${ansi.gray}${phText}${ansi.reset}` : "";
            const phLen = showPh ? displayWidth(phText) : 0;
            const linePlainLen = 2 + displayWidth(pfx) + displayWidth(txt);
            const padComposer = Math.max(0, cols - linePlainLen - phLen);
            out.push(
                `${ansi.barBg}${ansi.orange}┃ ${ansi.white}${pfx}${txt}${placeholder}${" ".repeat(padComposer)}${ansi.reset}\x1b[K\n`
            );
        }
        out.push(boxPad);

        // 5) Bottom Footer Status & Keybinds
        const shortModel = this.status.model.length > 20 ? `...${this.status.model.slice(-17)}` : this.status.model;
        const apiTag = `${this.status.provider}(${this.status.providerType})`;
        const ctxSeg = this.status.ctxText ? ` · ${this.status.ctxText}` : "";
        const modeTag = this.status.agentMode || (this.status.auto ? "auto" : "default");
        const taskParts = [];
        if (this.status.showActiveTasks !== false) {
            if (this.status.activeBgTasks > 0) taskParts.push(`Tasks:${this.status.activeBgTasks}`);
            if (this.status.activeTodos > 0) taskParts.push(`Todos:${this.status.activeTodos}`);
        }
        const taskSeg = taskParts.length ? ` · ${taskParts.join(" ")}` : "";
        const rawLeft = `Kovence CLI · Mode: ${modeTag} · ${apiTag} · ${shortModel}${ctxSeg}${taskSeg} · Tools ${this.status.tools ? "ON" : "OFF"}`;
        const maxLeftW = Math.max(20, cols - 2);
        const clampedLeft = clipToWidth(rawLeft, maxLeftW);
        const fullHints =
            this.scrollOffset > 0
                ? `[Scrolled +${this.scrollOffset}] Shift+Tab mode · Ctrl+Y copy · F2 select`
                : `Shift+Tab mode · Ctrl+S sessions · Ctrl+, settings · Ctrl+Y copy · F2 select`;
        const maxHintW = Math.max(0, cols - displayWidth(clampedLeft) - 3);
        const hintsRight = maxHintW >= 12 ? clipToWidth(fullHints, maxHintW) : "";
        const footerGap = hintsRight ? Math.max(1, cols - displayWidth(clampedLeft) - displayWidth(hintsRight) - 2) : 0;
        const footerBrand = clampedLeft.startsWith("Kovence CLI")
            ? `${ansi.orange}${ansi.bold}Kovence CLI${ansi.reset}${ansi.gray}${clampedLeft.slice(11)}`
            : `${ansi.gray}${clampedLeft}`;
        out.push(` ${footerBrand}${hintsRight ? `${" ".repeat(footerGap)}${hintsRight}` : ""}${ansi.reset}\x1b[K`);

        // Exact cursor placement (accounts cleanly for wrapped modal header lines)
        const curLineText = compLayout.lines[compLayout.curRow] || "";
        const curColVis = displayWidth(curLineText.slice(0, compLayout.curCol));
        const inputRow = headerRows + viewHeight + pickerRows + sugRows + 2 + modalLines.length + (compLayout.curRow - compStart);
        const inputCol = Math.min(cols, 2 + displayWidth(promptPrefix) + curColVis + 1);
        out.push(`\x1b[${inputRow};${inputCol}H`, ansi.showCur);

        this.stdout.write(CONTROL_SEQ.syncStart + out.join("") + CONTROL_SEQ.syncEnd);
    }

    /**
     * Dispatch keys strictly inside the active UI mode so keys never leak across modes (B8).
     */
    onKey(str, key = {}) {
        if (this.selStart || this.selEnd) {
            this.selStart = null;
            this.selEnd = null;
        }

        if (this.modal) return this._handleModalKey(str, key);
        if (this.permScreen) return this._handlePermissionsKey(str, key);
        if (this.settingsScreen) return this._handleSettingsKey(str, key);
        if (this.picker) return this._handlePickerKey(str, key);
        return this._handleComposerKey(str, key);
    }

    _handleModalKey(str, key) {
        if (key.ctrl && key.name === "c") {
            const now = Date.now();
            const isDouble = now - this.lastCtrlCAt < 2500;
            this.lastCtrlCAt = now;
            const { resolve } = this.modal;
            this.modal = null;
            this.scheduleRender();
            resolve("");
            if (isDouble) {
                this.onExit?.();
            } else {
                this.onCancel?.();
                this.flashNotice("Cancelled current task (press Ctrl+C again to exit)", 2400);
            }
            return;
        }
        if (key.name === "escape") {
            const { resolve } = this.modal;
            this.modal = null;
            this.scheduleRender();
            resolve("");
            return;
        }
        if (key.name === "return" || key.name === "enter") {
            const { resolve, buf } = this.modal;
            this.modal = null;
            this.scheduleRender();
            resolve(buf);
            return;
        }
        if (key.name === "backspace") {
            const prev = prevGraphemeBoundary(this.modal.buf, this.modal.buf.length);
            this.modal.buf = this.modal.buf.slice(0, prev);
            this.scheduleRender();
            return;
        }
        if (str && !key.ctrl && !key.meta && str >= " ") {
            this.modal.buf += str;
            this.scheduleRender();
        }
    }

    _handlePickerKey(str, key) {
        const { items, resolve } = this.picker;
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
            this.picker = null;
            this.scheduleRender();
            resolve(null);
            return;
        }
        if (!items.length) return;
        const stepPicker = (dir) => {
            let next = this.picker.selIdx;
            for (let tries = 0; tries < items.length; tries++) {
                next = (next + dir + items.length) % items.length;
                if (items[next]?.type !== "header") break;
            }
            this.picker.selIdx = next;
        };
        if (key.name === "up") {
            stepPicker(-1);
            this.scheduleRender();
            return;
        }
        if (key.name === "down") {
            stepPicker(1);
            this.scheduleRender();
            return;
        }
        if (key.name === "return" || key.name === "enter") {
            const chosen = items[this.picker.selIdx];
            if (!chosen || chosen.type === "header") return;
            this.picker = null;
            this.scheduleRender();
            resolve({ action: "select", item: chosen });
            return;
        }
        if (key.name === "delete" || str === "d") {
            const chosen = items[this.picker.selIdx];
            if (chosen && chosen.type === "session") {
                this.picker = null;
                this.scheduleRender();
                resolve({ action: "delete", item: chosen });
            }
        }
    }

    _handlePermissionsKey(str, key) {
        const rules = this.onGetPermissionRules ? this.onGetPermissionRules() : [];
        const filtered = getFilteredPermissions(rules, this.permScreen.search);

        if (key.ctrl && key.name === "c") {
            this.permScreen = null;
            this.scheduleRender();
            return;
        }
        if (key.name === "escape") {
            if (this.permScreen.search) {
                this.permScreen.search = "";
                this.permScreen.selIdx = 0;
            } else {
                this.permScreen = null;
            }
            this.scheduleRender();
            return;
        }
        if (key.name === "up" && filtered.length) {
            this.permScreen.selIdx = (this.permScreen.selIdx - 1 + filtered.length) % filtered.length;
            this.scheduleRender();
            return;
        }
        if (key.name === "down" && filtered.length) {
            this.permScreen.selIdx = (this.permScreen.selIdx + 1) % filtered.length;
            this.scheduleRender();
            return;
        }
        if ((key.name === "delete" || (str === "d" && !this.permScreen.search)) && filtered.length) {
            const sel = filtered[this.permScreen.selIdx];
            if (sel) {
                const removed = this.onRemovePermissionRule?.(sel);
                this.permScreen.notice = removed
                    ? `Removed rule: ${sel.tool} (${sel.pattern || "*"})`
                    : "Session rules reset when exiting or via /permissions reset.";
            }
            this.scheduleRender();
            return;
        }
        if (key.name === "backspace") {
            if (this.permScreen.search) {
                const prev = prevGraphemeBoundary(this.permScreen.search, this.permScreen.search.length);
                this.permScreen.search = this.permScreen.search.slice(0, prev);
                this.permScreen.selIdx = 0;
                this.scheduleRender();
            }
            return;
        }
        if (str && !key.ctrl && !key.meta && str >= " ") {
            this.permScreen.search += str;
            this.permScreen.selIdx = 0;
            this.permScreen.notice = "";
            this.scheduleRender();
        }
    }

    _handleSettingsKey(str, key) {
        const sState = this.settingsScreen;
        const settings = this.onGetSettings ? this.onGetSettings() : {};
        const items = getFilteredSettings(settings, sState.search);

        // Inline edit sub-mode (validation on Enter, no NaN allowed)
        if (sState.editing) {
            if (key.name === "escape" || (key.ctrl && key.name === "c")) {
                sState.editing = null;
                sState.editError = "";
                this.scheduleRender();
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                const parsed = parseSettingValue(sState.editing.key, sState.editing.buf);
                if (!parsed.ok) {
                    sState.editError = parsed.error;
                    this.scheduleRender();
                    return;
                }
                this.onUpdateSetting?.(parsed.key, parsed.value);
                sState.editing = null;
                sState.editError = "";
                this.scheduleRender();
                return;
            }
            if (key.name === "left") {
                sState.editing.cursor = prevGraphemeBoundary(sState.editing.buf, sState.editing.cursor);
                this.scheduleRender();
                return;
            }
            if (key.name === "right") {
                sState.editing.cursor = nextGraphemeBoundary(sState.editing.buf, sState.editing.cursor);
                this.scheduleRender();
                return;
            }
            if (key.name === "backspace") {
                if (sState.editing.cursor > 0) {
                    const prev = prevGraphemeBoundary(sState.editing.buf, sState.editing.cursor);
                    sState.editing.buf = sState.editing.buf.slice(0, prev) + sState.editing.buf.slice(sState.editing.cursor);
                    sState.editing.cursor = prev;
                    sState.editError = "";
                    this.scheduleRender();
                }
                return;
            }
            if (key.ctrl && key.name === "u") {
                sState.editing.buf = "";
                sState.editing.cursor = 0;
                this.scheduleRender();
                return;
            }
            if (str && !key.ctrl && !key.meta && str >= " ") {
                const c = sState.editing.cursor;
                sState.editing.buf = sState.editing.buf.slice(0, c) + str + sState.editing.buf.slice(c);
                sState.editing.cursor = c + str.length;
                sState.editError = "";
                this.scheduleRender();
            }
            return;
        }

        if (key.ctrl && key.name === "c") {
            this.settingsScreen = null;
            this.scheduleRender();
            return;
        }
        if (key.name === "escape") {
            if (sState.search) {
                sState.search = "";
                sState.selIdx = 0;
                sState.editError = "";
            } else {
                this.settingsScreen = null;
            }
            this.scheduleRender();
            return;
        }
        if (key.name === "up" && items.length) {
            sState.selIdx = (sState.selIdx - 1 + items.length) % items.length;
            sState.editError = "";
            this.scheduleRender();
            return;
        }
        if (key.name === "down" && items.length) {
            sState.selIdx = (sState.selIdx + 1) % items.length;
            sState.editError = "";
            this.scheduleRender();
            return;
        }

        const current = items[sState.selIdx];
        if ((key.name === "left" || key.name === "right") && current) {
            const dir = key.name === "right" ? 1 : -1;
            if (current.meta.key === "provider" && this.onGetProviders) {
                const provNames = this.onGetProviders();
                if (provNames.length > 0) {
                    const idx = Math.max(0, provNames.indexOf(current.value));
                    const nextProv = provNames[(idx + dir + provNames.length) % provNames.length];
                    this.onUpdateSetting?.("provider", nextProv);
                    this.onRefreshModels?.();
                    this.scheduleRender();
                    return;
                }
            }
            if (current.meta.key === "model" && this.onGetModels) {
                const modelList = this.onGetModels();
                if (modelList.length > 0) {
                    const idx = Math.max(0, modelList.indexOf(current.value));
                    const nextModel = modelList[(idx + dir + modelList.length) % modelList.length];
                    this.onUpdateSetting?.("model", nextModel);
                    this.scheduleRender();
                    return;
                }
            }
            const nextVal = stepSettingValue(current.meta.key, current.value, dir);
            if (nextVal !== null) {
                this.onUpdateSetting?.(current.meta.key, nextVal);
                sState.editError = "";
                this.scheduleRender();
            }
            return;
        }

        if ((key.name === "return" || key.name === "enter") && current) {
            if (current.meta.key === "managePermissions") {
                this.openManagePermissions();
                return;
            }
            if ((current.meta.key === "provider" || current.meta.key === "model") && this.onPickSettingChoice) {
                this.onPickSettingChoice(current.meta.key);
                return;
            }
            if (current.meta.type === "boolean" || current.meta.type === "enum") {
                const nextVal = stepSettingValue(current.meta.key, current.value, 1);
                if (nextVal !== null) this.onUpdateSetting?.(current.meta.key, nextVal);
                this.scheduleRender();
                return;
            }
            const initBuf = current.value === null || current.value === undefined ? "" : String(current.value);
            sState.editing = {
                key: current.meta.key,
                label: current.meta.label,
                buf: initBuf,
                cursor: initBuf.length,
            };
            sState.editError = "";
            this.scheduleRender();
            return;
        }

        if (key.name === "backspace") {
            if (sState.search) {
                const prev = prevGraphemeBoundary(sState.search, sState.search.length);
                sState.search = sState.search.slice(0, prev);
                sState.selIdx = 0;
                this.scheduleRender();
            }
            return;
        }
        if (key.ctrl && key.name === "u") {
            sState.search = "";
            sState.selIdx = 0;
            this.scheduleRender();
            return;
        }
        if (str && !key.ctrl && !key.meta && str >= " ") {
            sState.search += str;
            sState.selIdx = 0;
            sState.editError = "";
            this.scheduleRender();
        }
    }

    _getAtFileSuggestions() {
        const before = this.input.slice(0, this.cursor);
        const match = before.match(/(?:^|\s)@([^\s]*)$/);
        if (!match) return [];
        const query = (match[1] || "").toLowerCase();
        const now = Date.now();
        if (!this._fileCache.files.length || now - this._fileCache.ts > 5000) {
            try {
                const { entries } = walkWorkspace(this.workspaceRoot, {
                    maxDepth: 6,
                    maxEntries: 600,
                    includeDirs: false,
                    cwdRoot: this.workspaceRoot,
                });
                this._fileCache = { ts: now, files: entries };
            } catch {
                this._fileCache = { ts: now, files: [] };
            }
        }
        const prefixLen = match[1].length;
        const startIdx = this.cursor - prefixLen;
        const after = this.input.slice(this.cursor);
        const hits = [];
        for (const rel of this._fileCache.files) {
            const lower = rel.toLowerCase();
            if (!query || lower.includes(query)) {
                hits.push({
                    rel,
                    score: lower.startsWith(query) ? 0 : lower.split("/").pop().startsWith(query) ? 1 : 2,
                });
            }
        }
        hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
        return hits.slice(0, 6).map(({ rel }) => ({
            cmd: `@${rel}`,
            label: `@${rel}`,
            fill: `${this.input.slice(0, startIdx)}${rel} ${after}`,
            desc: "file",
            isFileMention: true,
        }));
    }

    _getActiveSuggestions() {
        if (this.input.startsWith("/")) return getSlashSuggestions(this.input);
        return this._getAtFileSuggestions();
    }

    _prevWordBoundary(pos) {
        let i = Math.max(0, pos);
        while (i > 0 && /\s/.test(this.input[i - 1])) i--;
        while (i > 0 && !/\s/.test(this.input[i - 1])) i--;
        return i;
    }

    _nextWordBoundary(pos) {
        let i = Math.min(this.input.length, pos);
        while (i < this.input.length && !/\s/.test(this.input[i])) i++;
        while (i < this.input.length && /\s/.test(this.input[i])) i++;
        return i;
    }

    _handleComposerKey(str, key) {
        if (key.name === "f2") {
            this.toggleMouseMode();
            return;
        }
        if (key.ctrl && key.name === "y") {
            this.copyLastResponse();
            return;
        }
        if (key.ctrl && key.name === "s") {
            this.onOpenSessions?.();
            return;
        }
        if (key.ctrl && key.name === "n") {
            this.onNewSession?.();
            return;
        }
        if (key.ctrl && key.name === "o") {
            this.toggleLastCollapsibleBlock();
            return;
        }
        if (key.ctrl && key.name === "l") {
            this.scrollOffset = 0;
            this.stdout.write("\x1b[2J\x1b[H");
            this.scheduleRender();
            return;
        }
        if (key.name === "tab" && key.shift) {
            this.onCycleMode?.();
            return;
        }
        const busy = Boolean(this.status.isBusy || this.status.busyLabel);
        if (key.name === "escape") {
            if (this.input.length > 0) {
                this.input = "";
                this.cursor = 0;
                this.selIdx = 0;
                this.scheduleRender();
                return;
            }
            if (busy) {
                this.onCancel?.();
                this.flashNotice("Cancelled task — restored to input box", 2200);
            }
            return;
        }
        if (key.ctrl && key.name === "c") {
            const now = Date.now();
            if (busy) {
                if (now - this.lastCtrlCAt < 2500) {
                    this.onExit?.();
                } else {
                    this.lastCtrlCAt = now;
                    this.onCancel?.();
                    this.flashNotice("Cancelled task — restored to input (press Ctrl+C again to exit)", 2400);
                }
            } else {
                this.onExit?.();
            }
            return;
        }
        if (key.ctrl && key.name === "d" && !this.input.length) {
            this.onExit?.();
            return;
        }
        if (key.name === "pageup") {
            this.scrollOffset += 6;
            this.scheduleRender();
            return;
        }
        if (key.name === "pagedown") {
            this.scrollOffset = Math.max(0, this.scrollOffset - 6);
            this.scheduleRender();
            return;
        }
        // Shift+Enter, Alt+Enter, or Ctrl+J -> newline inside multi-line composer (preserved intact)
        if (
            key.sequence === "\n" ||
            ((key.name === "return" || key.name === "enter") && (key.shift || key.meta)) ||
            key.name === "linefeed" ||
            (key.ctrl && key.name === "j")
        ) {
            this.insertNewline();
            return;
        }
        if (key.name === "return" || key.name === "enter") {
            const activeSugs = this._getActiveSuggestions();
            if (activeSugs.length && activeSugs[0]?.isFileMention) {
                const picked = activeSugs[Math.min(this.selIdx, activeSugs.length - 1)];
                this.input = picked.fill;
                this.cursor = this.input.length;
                this.selIdx = 0;
                this.scheduleRender();
                return;
            }
            const res = resolveSlashEnter(this.input, this.selIdx);
            if (res.action === "fill") {
                this.input = res.value;
                this.cursor = this.input.length;
                this.selIdx = 0;
                this.scheduleRender();
                return;
            }
            const val = res.value;
            this.input = "";
            this.cursor = 0;
            this.selIdx = 0;
            if (val) {
                this.scrollOffset = 0;
                if (!val.startsWith("/") && this.inputHistory[this.inputHistory.length - 1] !== val) {
                    this.inputHistory.push(val);
                    this.onSaveInputHistory?.(this.inputHistory);
                }
                this.histIdx = this.inputHistory.length;
                this.onSubmit?.(val);
            }
            this.scheduleRender();
            return;
        }
        if (key.name === "tab") {
            const suggestions = this._getActiveSuggestions();
            if (suggestions.length) {
                this.input = suggestions[Math.min(this.selIdx, suggestions.length - 1)].fill;
                this.cursor = this.input.length;
                this.selIdx = 0;
                this.scheduleRender();
            }
            return;
        }
        if (key.name === "up") {
            const suggestions = this._getActiveSuggestions();
            if (suggestions.length) {
                this.selIdx = (this.selIdx - 1 + suggestions.length) % suggestions.length;
            } else if (this.inputHistory.length && this.histIdx > 0) {
                this.histIdx--;
                this.input = this.inputHistory[this.histIdx];
                this.cursor = this.input.length;
            }
            this.scheduleRender();
            return;
        }
        if (key.name === "down") {
            const suggestions = this._getActiveSuggestions();
            if (suggestions.length) {
                this.selIdx = (this.selIdx + 1) % suggestions.length;
            } else if (this.histIdx < this.inputHistory.length) {
                this.histIdx++;
                this.input = this.histIdx < this.inputHistory.length ? this.inputHistory[this.histIdx] : "";
                this.cursor = this.input.length;
            }
            this.scheduleRender();
            return;
        }
        if ((key.ctrl && key.name === "left") || (key.meta && key.name === "b")) {
            this.cursor = this._prevWordBoundary(this.cursor);
            this.scheduleRender();
            return;
        }
        if ((key.ctrl && key.name === "right") || (key.meta && key.name === "f")) {
            this.cursor = this._nextWordBoundary(this.cursor);
            this.scheduleRender();
            return;
        }
        if (key.name === "left") {
            this.cursor = prevGraphemeBoundary(this.input, this.cursor);
            this.scheduleRender();
            return;
        }
        if (key.name === "right") {
            this.cursor = nextGraphemeBoundary(this.input, this.cursor);
            this.scheduleRender();
            return;
        }
        if (key.name === "home" || (key.ctrl && key.name === "a")) {
            this.cursor = 0;
            this.scheduleRender();
            return;
        }
        if (key.name === "end" || (key.ctrl && key.name === "e")) {
            this.cursor = this.input.length;
            this.scheduleRender();
            return;
        }
        if ((key.meta && key.name === "backspace") || (key.ctrl && key.name === "w")) {
            if (this.cursor > 0) {
                const prev = this._prevWordBoundary(this.cursor);
                this.input = this.input.slice(0, prev) + this.input.slice(this.cursor);
                this.cursor = prev;
                this.selIdx = 0;
                this.scheduleRender();
            }
            return;
        }
        if (key.name === "backspace") {
            if (this.cursor > 0) {
                const prev = prevGraphemeBoundary(this.input, this.cursor);
                this.input = this.input.slice(0, prev) + this.input.slice(this.cursor);
                this.cursor = prev;
                this.selIdx = 0;
                this.scheduleRender();
            }
            return;
        }
        if (key.name === "delete") {
            if (this.cursor < this.input.length) {
                const next = nextGraphemeBoundary(this.input, this.cursor);
                this.input = this.input.slice(0, this.cursor) + this.input.slice(next);
                this.selIdx = 0;
                this.scheduleRender();
            }
            return;
        }
        if (key.ctrl && key.name === "u") {
            this.input = "";
            this.cursor = 0;
            this.selIdx = 0;
            this.scheduleRender();
            return;
        }
        if (str && !key.ctrl && !key.meta && str >= " ") {
            this.input = this.input.slice(0, this.cursor) + str + this.input.slice(this.cursor);
            this.cursor += str.length;
            this.selIdx = 0;
            this.scheduleRender();
        }
    }
}

module.exports = { KovenceTUI, layoutComposer };
