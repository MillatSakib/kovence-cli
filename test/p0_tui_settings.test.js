"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { KovenceTUI, layoutComposer } = require("../tui");
const { stripAnsi, displayWidth, wrapPlain, clipToWidth, prevGraphemeBoundary } = require("../src/tui/text_width");

function createFakeTty() {
    const chunks = [];
    const stdout = new EventEmitter();
    stdout.columns = 100;
    stdout.rows = 28;
    stdout.isTTY = true;
    stdout.write = (s) => {
        chunks.push(String(s));
        return true;
    };
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    return {
        stdout,
        stdin,
        getOutput: () => chunks.join(""),
        clearOutput: () => {
            chunks.length = 0;
        },
    };
}

test("B10: Intl.Segmenter Unicode wrapping/clipping/cursor avoids broken surrogates and Bangla conjuncts", () => {
    const bangla = "ক্লান্তিক্ষমা বাংলা 🔥👨‍👩‍👧 end";
    const wrapped = wrapPlain(bangla, 10);
    for (const line of wrapped) {
        assert.equal(line.includes("\uFFFD"), false);
    }

    const clipped = clipToWidth("👨‍👩‍👧🔥 বাংলা", 5);
    assert.equal(clipped.includes("\uFFFD"), false);
    assert.ok(displayWidth(clipped) <= 5);

    const sample = "a🔥";
    const prev = prevGraphemeBoundary(sample, sample.length);
    assert.equal(prev, 1); // Steps past full surrogate pair emoji, not half of it

    // Multi-line composer preserves newlines + cursor row/col
    const comp = layoutComposer("আমি বাংলায়\nগান গাই", "আমি বাংলায়\nগান".length, 30);
    assert.equal(comp.lines.length, 2);
    assert.equal(comp.curRow, 1);
    assert.equal(comp.lines[1].slice(0, comp.curCol), "গান");
});

test("A1 + B8: interactive Settings panel filters, cycles, validates No NaN, manages permissions, and isolates keys", () => {
    const { stdout, stdin, getOutput, clearOutput } = createFakeTty();
    const state = { agentMode: "default", maxToolSteps: 25, verbosity: "normal", colorScheme: "amber" };
    const rules = [
        {
            id: "r1",
            origin: "project",
            action: "allow",
            tool: "run_command",
            scope: "commandPrefix",
            pattern: "npm test",
            createdAt: "2026-01-01",
        },
    ];

    const tui = new KovenceTUI({
        stdout,
        stdin,
        onGetSettings: () => state,
        onUpdateSetting: (k, v) => {
            state[k] = v;
        },
        onGetPermissionRules: () => rules,
        onRemovePermissionRule: (r) => {
            const idx = rules.findIndex((x) => x.id === r.id);
            if (idx >= 0) return rules.splice(idx, 1)[0];
            return null;
        },
    });
    tui.active = true;

    tui.openSettings();
    tui.render();
    let plain = stripAnsi(getOutput());
    assert.match(plain, /Settings/);
    assert.match(plain, /Search:/);
    assert.match(plain, /Agent Mode/);
    assert.match(plain, /Keyboard: ↑\/↓ Navigate, ←\/→ Change, enter Select, esc Clear Search\/Exit/);

    // Filter with search box: Esc clears search first, second Esc closes Settings!
    tui.onKey("m", { name: "m" });
    tui.onKey("a", { name: "a" });
    tui.onKey("x", { name: "x" });
    assert.equal(tui.settingsScreen.search, "max");
    assert.equal(tui.input, ""); // B8: never leaks to composer!

    // Cycle right on Max Tool Steps shouldn't crash; Enter opens inline editor
    clearOutput();
    tui.onKey("", { name: "return" });
    assert.ok(tui.settingsScreen.editing);
    tui.onKey("", { ctrl: true, name: "u" });
    tui.onKey("a", { name: "a" });
    tui.onKey("b", { name: "b" });
    tui.onKey("", { name: "return" }); // Invalid integer -> error, stays open!
    assert.match(tui.settingsScreen.editError, /whole number/i);
    assert.equal(state.maxToolSteps, 25);

    tui.onKey("", { ctrl: true, name: "u" });
    tui.onKey("3", { name: "3" });
    tui.onKey("5", { name: "5" });
    tui.onKey("", { name: "return" });
    assert.equal(tui.settingsScreen.editing, null);
    assert.equal(state.maxToolSteps, 35);

    // First Esc clears search filter, stays in Settings
    tui.onKey("", { name: "escape" });
    assert.equal(tui.settingsScreen.search, "");
    assert.ok(tui.settingsScreen);

    // Cycle Agent Mode with Right arrow
    tui.onKey("", { name: "right" });
    assert.equal(state.agentMode, "accept-edits");

    // Manage Permissions screen opens & deletes rule with 'd'
    tui.openManagePermissions();
    clearOutput();
    tui.render();
    assert.match(stripAnsi(getOutput()), /Manage Permissions/);
    assert.match(stripAnsi(getOutput()), /npm test/);
    tui.onKey("d", { name: "d" });
    assert.equal(rules.length, 0);
    tui.onKey("", { name: "escape" });
    assert.equal(tui.permScreen, null);

    // Second Esc exits Settings cleanly
    tui.onKey("", { name: "escape" });
    assert.equal(tui.settingsScreen, null);
    assert.equal(tui.input, "");
});

test("B24: TUI block formatting cache and scroll anchor preserve reading position during streaming", () => {
    const { stdout, stdin } = createFakeTty();
    const tui = new KovenceTUI({ stdout, stdin });
    tui.active = true;

    for (let i = 0; i < 40; i++) {
        tui.addBlock("assistant", `Line number ${i}\nAnother line ${i}`);
    }
    tui.render();

    // User scrolls up to read earlier output
    tui.scrollOffset = 10;
    const prevOffset = tui.scrollOffset;
    const streamBlock = tui.blocks[tui.blocks.length - 1];
    tui.appendBlock(streamBlock, "\nNew streamed line 1\nNew streamed line 2");
    tui.render();

    assert.equal(tui.scrollOffset, prevOffset + 2);
});

test("Clicking a collapsible command block toggles live dim inner output without breaking drag selection", () => {
    const { stdout, stdin, getOutput, clearOutput } = createFakeTty();
    const tui = new KovenceTUI({ stdout, stdin });
    tui.active = true;

    const cmdBlock = tui.addBlock("tool", "⚙ run_command(sudo apt upgrade -y)", {
        collapsible: true,
        expanded: false,
        details: ["Reading package lists...", "Building dependency tree...", "Unpacking pkg-a (1.0)..."],
        statusLine: "Unpacking pkg-a (1.0)...",
    });
    tui.render();

    let rendered = stripAnsi(getOutput());
    assert.match(rendered, /▸ ⚙ run_command\(sudo apt upgrade -y\)/);
    assert.match(rendered, /Unpacking pkg-a/);
    assert.doesNotMatch(rendered, /Reading package lists/);

    // Find visual row of the command block inside viewport
    const absIdx = tui.lastViewState.lineBlocks.findIndex((b) => b === cmdBlock);
    assert.ok(absIdx >= 0);
    const screenY = 2 + 1 + (absIdx - tui.lastViewState.startIdx);

    // Single click (press & release at same column) expands live details
    clearOutput();
    tui.handleMouseEvent(0, 10, screenY, "M");
    tui.handleMouseEvent(0, 10, screenY, "m");
    tui.render();

    assert.equal(cmdBlock.expanded, true);
    rendered = stripAnsi(getOutput());
    assert.match(rendered, /▾ ⚙ run_command\(sudo apt upgrade -y\)/);
    assert.match(rendered, /Reading package lists/);
    assert.match(rendered, /Building dependency tree/);
    assert.match(rendered, /Unpacking pkg-a/);

    // Dragging across columns selects text instead of collapsing the block
    tui.handleMouseEvent(0, 5, screenY, "M");
    tui.handleMouseEvent(32, 25, screenY, "M");
    tui.handleMouseEvent(0, 25, screenY, "m");
    assert.equal(cmdBlock.expanded, true);

    // Another single click collapses it back
    tui.handleMouseEvent(0, 10, screenY, "M");
    tui.handleMouseEvent(0, 10, screenY, "m");
    assert.equal(cmdBlock.expanded, false);
});

test("Slash commands are excluded from prompt inputHistory so Up/Down arrow never gets stuck on /commands", () => {
    const { stdout, stdin } = createFakeTty();
    const submitted = [];
    const tui = new KovenceTUI({
        stdout,
        stdin,
        onSubmit: (v) => submitted.push(v),
    });
    tui.active = true;

    tui.setInput("first real prompt");
    tui.onKey("", { name: "return" });

    tui.setInput("/settings");
    tui.onKey("", { name: "return" });

    tui.setInput("/stats");
    tui.onKey("", { name: "return" });

    tui.setInput("second real prompt");
    tui.onKey("", { name: "return" });

    assert.deepEqual(submitted, ["first real prompt", "/settings", "/stats", "second real prompt"]);
    assert.deepEqual(tui.inputHistory, ["first real prompt", "second real prompt"]);

    // Up arrow cycles cleanly through real prompts only
    tui.onKey("", { name: "up" });
    assert.equal(tui.input, "second real prompt");
    tui.onKey("", { name: "up" });
    assert.equal(tui.input, "first real prompt");
    tui.onKey("", { name: "down" });
    assert.equal(tui.input, "second real prompt");
});

test("/mode picker opens cleanly with active mode preselected and footer shows full Mode name", async () => {
    const { stdout, stdin, getOutput, clearOutput } = createFakeTty();
    stdout.columns = 95;
    const tui = new KovenceTUI({ stdout, stdin });
    tui.active = true;
    tui.setStatus({
        agentMode: "auto",
        provider: "default",
        providerType: "openai",
        model: "google/gemma-4-26b-a4b-it",
        ctxText: "Context: ~4188 / 150000 tokens",
    });

    const pickPromise = tui.openPicker(
        "Select Agent Mode (Shift+Tab)",
        [
            { type: "mode", id: "default", label: "  default", desc: "Ask confirmation" },
            { type: "mode", id: "accept-edits", label: "  accept-edits", desc: "Auto edits" },
            { type: "mode", id: "plan", label: "  plan", desc: "Read only" },
            { type: "mode", id: "auto", label: "● auto", desc: "Auto allow" },
        ],
        { initialIdx: 3, hint: "↑/↓ select · Enter apply · Esc close" }
    );
    clearOutput();
    tui.render();
    const out = stripAnsi(getOutput());
    assert.match(out, /Select Agent Mode/);
    assert.match(out, /Mode: auto/);

    // Move Up once to 'plan' and press Enter
    tui.onKey("", { name: "up" });
    tui.onKey("", { name: "return" });
    const res = await pickPromise;
    assert.equal(res?.action, "select");
    assert.equal(res?.item?.id, "plan");
});

test("/model browser shows Providers (+ Add/Remove) -> selected Provider Models (+ Add More Model) and switches both", async (t) => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { resolvePaths } = require("../src/config/paths");
    const { upsertProvider } = require("../src/config/providers");
    const { handleSlash } = require("../src/commands/handlers");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-model-browser-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const paths = resolvePaths({
        cwd: tmp,
        projectRoot: tmp,
        globalDir: path.join(tmp, "cfg"),
        projectDir: path.join(tmp, ".kovence"),
    });

    upsertProvider(
        { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        {
            name: "openrouter",
            type: "openai",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "or-k",
            models: ["openai/gpt-4o", "anthropic/claude-3.7-sonnet"],
        },
        paths
    );

    const pickerCalls = [];
    const answers = ["openrouter", "anthropic/claude-3.7-sonnet"];
    const sink = {
        logs: [],
        log: (k, text) => sink.logs.push({ k, text }),
        syncStatus: () => {},
        openChoicePicker: async (title, items) => {
            pickerCalls.push({ title, ids: items.map((x) => x.id) });
            return answers.shift() || "";
        },
    };

    const state = {
        paths,
        noSession: true,
        cliModel: "",
        provider: { name: "default", type: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", fromEnv: true },
        model: "m0",
        persistedSettings: { model: "" },
        settings: { agentMode: "default" },
        session: { id: "s1", model: "", history: [] },
    };

    await handleSlash(state, "/model", sink, {});
    assert.equal(pickerCalls.length, 2);
    assert.ok(pickerCalls[0].ids.includes("openrouter"));
    assert.ok(pickerCalls[0].ids.includes("__add_provider__"));
    assert.ok(pickerCalls[0].ids.includes("__remove_provider__"));
    assert.ok(pickerCalls[1].ids.includes("openai/gpt-4o"));
    assert.ok(pickerCalls[1].ids.includes("__add_more_model__"));
    assert.equal(state.provider.name, "openrouter");
    assert.equal(state.model, "anthropic/claude-3.7-sonnet");
});
