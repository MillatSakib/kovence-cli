"use strict";

const { SETTINGS_SCHEMA, parseSettingValue } = require("../settings/schema");
const { stepSettingValue } = require("../settings/store");
const { displayWidth, clipToWidth, wrapPlain, padRight } = require("./text_width");

function formatSettingDisplayValue(meta, value) {
    if (meta.type === "action") return "-> open";
    if (meta.type === "boolean") return value ? "on" : "off";
    if (value === null || value === undefined || value === "") return "(default)";
    if (meta.type === "multilineString") {
        const single = String(value).replace(/\s+/g, " ").trim();
        return single.length > 36 ? `${single.slice(0, 33)}...` : single;
    }
    return String(value);
}

function getFilteredSettings(settings, searchQuery = "") {
    const q = String(searchQuery || "")
        .trim()
        .toLowerCase();
    return SETTINGS_SCHEMA.filter((meta) => {
        if (!q) return true;
        return (
            meta.label.toLowerCase().includes(q) ||
            meta.key.toLowerCase().includes(q) ||
            meta.description.toLowerCase().includes(q)
        );
    }).map((meta) => ({
        meta,
        value: settings?.[meta.key],
        displayValue: formatSettingDisplayValue(meta, settings?.[meta.key]),
    }));
}

function getFilteredPermissions(rules, searchQuery = "") {
    const q = String(searchQuery || "")
        .trim()
        .toLowerCase();
    return (Array.isArray(rules) ? rules : [])
        .map((rule, idx) => ({ ...rule, displayIndex: idx + 1 }))
        .filter((rule) => {
            if (!q) return true;
            const hay = `${rule.origin} ${rule.tool} ${rule.scope} ${rule.pattern} ${rule.action}`.toLowerCase();
            return hay.includes(q);
        });
}

/**
 * Render the full-screen Antigravity-style Settings panel.
 */
function renderSettingsScreen({ cols, rows, settingsState, settings, ansi }) {
    const out = [ansi.hideCur, "\x1b[H"];
    const items = getFilteredSettings(settings, settingsState.search);
    if (settingsState.selIdx >= items.length) {
        settingsState.selIdx = Math.max(0, items.length - 1);
    }

    const searchLabel = "Search: ";
    const searchVal = settingsState.search || "";
    const ruleW = Math.min(28, Math.max(12, cols - 4));

    // Title + Search header (4 rows)
    out.push(`${ansi.bold}${ansi.white}Settings${ansi.reset}\x1b[K\n`);
    out.push(`\x1b[K\n`);
    out.push(`  ${ansi.gray}${searchLabel}${ansi.white}${searchVal}${ansi.reset}\x1b[K\n`);
    out.push(`  ${ansi.gray}${"─".repeat(ruleW)}${ansi.reset}\x1b[K\n`);

    const selectedItem = items[settingsState.selIdx] || null;
    const descText = settingsState.editError
        ? `Error: ${settingsState.editError}`
        : selectedItem
          ? selectedItem.meta.description
          : "No settings match your search.";
    const descLines = wrapPlain(descText, Math.max(20, cols - 4)).slice(0, 2);
    const footerRows = 2 + descLines.length; // blank + desc lines + keyboard hints
    const listHeight = Math.max(4, rows - 5 - footerRows);

    const startIdx = Math.max(
        0,
        Math.min(settingsState.selIdx - Math.floor(listHeight / 2), Math.max(0, items.length - listHeight))
    );
    const col1W = Math.min(30, Math.max(18, Math.floor(cols * 0.34)));

    out.push(`\x1b[K\n`);
    for (let r = 0; r < listHeight; r++) {
        const entry = items[startIdx + r];
        if (!entry) {
            out.push(`\x1b[K\n`);
            continue;
        }
        const active = startIdx + r === settingsState.selIdx;
        const accentColor = ansi.accent || ansi.orange;
        const marker = active ? `${accentColor}> ` : "  ";
        const namePart = padRight(
            clipToWidth(entry.meta.label, col1W),
            Math.min(displayWidth(entry.meta.label), col1W),
            col1W + 2
        );
        const valMax = Math.max(8, cols - col1W - 6);
        const valText = clipToWidth(entry.displayValue, valMax);
        const nameColor = active ? `${accentColor}${ansi.bold}` : ansi.white;
        const valColor = active ? `${accentColor}` : entry.meta.type === "action" ? ansi.orange : ansi.gray;
        out.push(`${marker}${nameColor}${namePart}${ansi.reset}${valColor}${valText}${ansi.reset}\x1b[K\n`);
    }

    // Inline edit overlay line OR description bar
    if (settingsState.editing) {
        const edit = settingsState.editing;
        const editLine = `Edit ${edit.label}: ${edit.buf}`;
        const clipped = clipToWidth(editLine, Math.max(12, cols - 4));
        out.push(`  ${ansi.orange}${ansi.bold}${clipped}${ansi.reset}\x1b[K\n`);
    } else {
        out.push(`\x1b[K\n`);
    }

    for (const dl of descLines) {
        const color = settingsState.editError ? ansi.red : ansi.gray;
        out.push(`  ${color}${clipToWidth(dl, Math.max(12, cols - 4))}${ansi.reset}\x1b[K\n`);
    }

    const footerHint = settingsState.editing
        ? "Edit: enter Save · backspace Delete · esc Cancel"
        : "Keyboard: ↑/↓ Navigate, ←/→ Change, enter Select, esc Clear Search/Exit";
    out.push(`  ${ansi.gray}${clipToWidth(footerHint, Math.max(12, cols - 4))}${ansi.reset}\x1b[K`);

    // Cursor position in Search box (or edit prompt)
    if (settingsState.editing) {
        const editCol = Math.min(
            cols,
            3 +
                displayWidth(
                    `Edit ${settingsState.editing.label}: ${settingsState.editing.buf.slice(0, settingsState.editing.cursor)}`
                )
        );
        out.push(`\x1b[${rows - footerRows + 1};${editCol}H`, ansi.showCur);
    } else {
        const searchCol = Math.min(cols, 3 + displayWidth(searchLabel + searchVal));
        out.push(`\x1b[3;${searchCol}H`, ansi.showCur);
    }

    return out.join("");
}

/**
 * Render the Manage Permissions rule inspector / deleter panel (A3 / A1).
 */
function renderPermissionsScreen({ cols, rows, permState, rules, ansi }) {
    const out = [ansi.hideCur, "\x1b[H"];
    const filtered = getFilteredPermissions(rules, permState.search);
    if (permState.selIdx >= filtered.length) {
        permState.selIdx = Math.max(0, filtered.length - 1);
    }

    const searchLabel = "Search: ";
    const searchVal = permState.search || "";
    const ruleW = Math.min(28, Math.max(12, cols - 4));

    out.push(
        `${ansi.bold}${ansi.white}Manage Permissions${ansi.reset}  ${ansi.gray}(project & global rules)${ansi.reset}\x1b[K\n`
    );
    out.push(`\x1b[K\n`);
    out.push(`  ${ansi.gray}${searchLabel}${ansi.white}${searchVal}${ansi.reset}\x1b[K\n`);
    out.push(`  ${ansi.gray}${"─".repeat(ruleW)}${ansi.reset}\x1b[K\n`);

    const listHeight = Math.max(4, rows - 8);
    const startIdx = Math.max(
        0,
        Math.min(permState.selIdx - Math.floor(listHeight / 2), Math.max(0, filtered.length - listHeight))
    );

    out.push(`\x1b[K\n`);
    if (filtered.length === 0) {
        out.push(
            `  ${ansi.gray}(No permission rules saved yet. Approve with [s] or [A], or use /permissions allow|deny)${ansi.reset}\x1b[K\n`
        );
        for (let r = 1; r < listHeight; r++) out.push(`\x1b[K\n`);
    } else {
        for (let r = 0; r < listHeight; r++) {
            const rule = filtered[startIdx + r];
            if (!rule) {
                out.push(`\x1b[K\n`);
                continue;
            }
            const active = startIdx + r === permState.selIdx;
            const accentColor = ansi.accent || ansi.orange;
            const marker = active ? `${accentColor}> ` : "  ";
            const badge = `[${rule.origin}]`.padEnd(10);
            const actionCol = rule.action.toUpperCase().padEnd(6);
            const toolCol = `${rule.tool}`.padEnd(16);
            const scopeCol = `${rule.scope}:${rule.pattern || "*"}`;
            const text = clipToWidth(`${badge} ${actionCol} ${toolCol} ${scopeCol}`, Math.max(16, cols - 6));
            const color = active ? `${accentColor}${ansi.bold}` : rule.action === "deny" ? ansi.red : ansi.white;
            out.push(`${marker}${color}${text}${ansi.reset}\x1b[K\n`);
        }
    }

    const sel = filtered[permState.selIdx];
    const info = permState.notice
        ? permState.notice
        : sel
          ? `Rule #${sel.displayIndex} · ${sel.origin} · created ${sel.createdAt || "unknown"}`
          : "Use ↑/↓ to browse saved permission rules.";
    out.push(`\x1b[K\n`);
    out.push(`  ${ansi.gray}${clipToWidth(info, Math.max(12, cols - 4))}${ansi.reset}\x1b[K\n`);
    out.push(
        `  ${ansi.gray}${clipToWidth("Keyboard: ↑/↓ Navigate, d/Del Delete Rule, esc Clear Search/Back", Math.max(12, cols - 4))}${ansi.reset}\x1b[K`
    );

    const searchCol = Math.min(cols, 3 + displayWidth(searchLabel + searchVal));
    out.push(`\x1b[3;${searchCol}H`, ansi.showCur);
    return out.join("");
}

module.exports = {
    formatSettingDisplayValue,
    getFilteredSettings,
    getFilteredPermissions,
    renderSettingsScreen,
    renderPermissionsScreen,
    stepSettingValue,
    parseSettingValue,
};
