"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const {
    resolvePaths,
    createEmptySession,
    upsertProvider,
} = require("../store");
const { persistAndApplySetting } = require("../src/commands/handlers");
const { getPalette } = require("../src/tui/themes");
const { renderSettingsScreen } = require("../src/tui/settings_panel");
const { KovenceTUI } = require("../tui");

test("Settings amber palette uses orange accent instead of blue", () => {
    const ansi = getPalette("amber");
    assert.equal(ansi.accent, "\x1b[38;5;208m");
    const rendered = renderSettingsScreen({
        cols: 90,
        rows: 24,
        settingsState: { search: "", selIdx: 0, editing: null, editError: "" },
        settings: { agentMode: "default", colorScheme: "amber", provider: "default", model: "gpt-4o" },
        ansi,
    });
    assert.equal(rendered.includes("\x1b[38;5;75m"), false);
    assert.equal(rendered.includes("\x1b[38;5;208m"), true);
});

test("persistAndApplySetting updates active model and switches provider+model dynamically", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-set-"));
    try {
        const paths = resolvePaths({
            cwd: tmp,
            projectRoot: tmp,
            globalDir: path.join(tmp, ".global"),
            projectDir: path.join(tmp, ".kovence"),
        });
        const envFallback = { name: "default", type: "openai", baseUrl: "http://localhost:4000", apiKey: "sk-test", defaultModel: "gpt-4o" };
        upsertProvider(
            envFallback,
            { name: "custom1", type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-123", defaultModel: "claude-sonnet-4", models: ["claude-sonnet-4", "claude-opus-4"] },
            paths
        );

        const state = {
            paths,
            noSession: false,
            cliModel: "",
            provider: envFallback,
            model: "gpt-4o",
            persistedSettings: { provider: "default", model: "" },
            settings: { agentMode: "default", provider: "default", model: "" },
            session: createEmptySession("s1", "gpt-4o"),
        };
        const sink = { log: () => {}, syncStatus: () => {} };

        assert.equal(persistAndApplySetting(state, "model", "gpt-4.1", sink), true);
        assert.equal(state.model, "gpt-4.1");
        assert.equal(state.session.model, "gpt-4.1");

        assert.equal(persistAndApplySetting(state, "provider", "custom1", sink), true);
        assert.equal(state.provider.name, "custom1");
        assert.equal(state.model, "claude-sonnet-4");
        assert.equal(state.session.model, "claude-sonnet-4");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("KovenceTUI /settings cycles dynamic models with Left/Right and respects showTips & showActiveTasks", () => {
    const stdout = new PassThrough();
    let lastFrame = "";
    stdout.write = (chunk) => {
        lastFrame += String(chunk);
        return true;
    };
    stdout.columns = 110;
    stdout.rows = 30;
    const stdin = new PassThrough();
    stdin.setRawMode = () => {};

    let currentModel = "m1";
    let pickedKey = "";
    const tui = new KovenceTUI({
        stdout,
        stdin,
        onGetSettings: () => ({ agentMode: "default", provider: "default", model: currentModel }),
        onGetModels: () => ["m1", "m2", "m3"],
        onUpdateSetting: (k, v) => {
            if (k === "model") currentModel = v;
        },
        onPickSettingChoice: (k) => {
            pickedKey = k;
        },
    });

    tui.openSettings();
    tui.settingsScreen.search = "model";
    tui._handleSettingsKey("", { name: "right" });
    assert.equal(currentModel, "m2");

    tui._handleSettingsKey("", { name: "return" });
    assert.equal(pickedKey, "model");

    tui.settingsScreen = null;
    tui.setStatus({ showTips: false, showActiveTasks: true, activeBgTasks: 2, activeTodos: 1, model: "m2" });
    lastFrame = "";
    tui.render();
    assert.equal(lastFrame.includes("Type message · Shift+Enter newline"), false);
    assert.equal(lastFrame.includes("Tasks:2 Todos:1"), true);
});
