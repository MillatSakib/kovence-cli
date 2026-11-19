"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { execFileSync } = require("node:child_process");

const {
    resolvePaths,
    createEmptySession,
    saveSession,
    listSessions,
    groupSessionsByDate,
    suggestSessionIdFromPrompt,
    loadInputHistory,
    saveInputHistory,
} = require("../store");
const { handleSlash } = require("../src/commands/handlers");
const { expandFileMentions } = require("../src/agent/turn");
const { parseArgs } = require("../src/cli/args");
const { KovenceTUI } = require("../tui");

function makeTempPaths() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-p1-3-"));
    return {
        tmp,
        paths: resolvePaths({
            cwd: tmp,
            projectRoot: tmp,
            globalDir: path.join(tmp, ".global"),
            projectDir: path.join(tmp, ".kovence"),
        }),
    };
}

test("F7: /rename, /fork, /export, /edit-last, and /cost work end-to-end", async () => {
    const { tmp, paths } = makeTempPaths();
    try {
        const session = createEmptySession("orig-1", "gpt-4o");
        session.history.push(
            { role: "user", content: "Explain @foo.js\n\n--- File: foo.js ---\nconsole.log(1);" },
            { role: "assistant", content: "It logs 1." }
        );
        session.stats.promptTokens = 1000;
        session.stats.completionTokens = 250;
        saveSession(session, paths);

        const logs = [];
        let restoredInput = "";
        const state = {
            paths,
            workspaceRoot: tmp,
            noSession: false,
            model: "gpt-4o",
            settings: { agentMode: "default" },
            session,
        };
        const sink = {
            log: (_k, msg) => logs.push(msg),
            syncStatus: () => {},
            clear: () => {},
            setInput: (val) => {
                restoredInput = val;
            },
        };

        await handleSlash(state, "/rename renamed-1", sink);
        assert.equal(state.session.id, "renamed-1");

        await handleSlash(state, "/fork branched-1", sink);
        assert.equal(state.session.id, "branched-1");
        assert.equal(state.session.history.length, 2);

        await handleSlash(state, "/export md export_test.md", sink);
        const mdText = fs.readFileSync(path.join(tmp, "export_test.md"), "utf8");
        assert.match(mdText, /# Kovence Session: branched-1/);
        assert.match(mdText, /It logs 1\./);

        await handleSlash(state, "/cost", sink);
        assert.ok(logs.some((l) => l.includes("Estimated Cost: $")));

        await handleSlash(state, "/edit-last", sink);
        assert.equal(state.session.history.length, 0);
        assert.equal(restoredInput, "Explain @foo.js");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("F8: expandFileMentions supports @file:L10-50 line ranges and persistent inputHistory excludes /commands", () => {
    const { tmp, paths } = makeTempPaths();
    try {
        const sampleFile = path.join(tmp, "sample.txt");
        fs.writeFileSync(sampleFile, "line1\nline2\nline3\nline4\n", "utf8");
        const out = expandFileMentions("Check @sample.txt:L2-3 please", tmp);
        assert.match(out, /--- File: sample\.txt \(Lines 2-3\) ---/);
        assert.match(out, /2: line2/);
        assert.match(out, /3: line3/);
        assert.doesNotMatch(out, /4: line4/);

        saveInputHistory(["hello", "/help", "fix bug"], paths);
        assert.deepEqual(loadInputHistory(paths), ["hello", "fix bug"]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("F8: KovenceTUI @ file picker, Ctrl+L, and word-nav/delete work cleanly", () => {
    const { tmp } = makeTempPaths();
    try {
        fs.writeFileSync(path.join(tmp, "alpha_helper.js"), "module.exports = 1;\n", "utf8");
        const stdout = new PassThrough();
        stdout.columns = 100;
        stdout.rows = 30;
        const stdin = new PassThrough();
        stdin.setRawMode = () => {};

        const tui = new KovenceTUI({
            workspaceRoot: tmp,
            stdout,
            stdin,
            onSubmit: () => {},
        });

        tui.setInput("open @alp");
        const sugs = tui._getActiveSuggestions();
        assert.ok(sugs.length >= 1);
        assert.equal(sugs[0].cmd, "@alpha_helper.js");

        tui._handleComposerKey("", { name: "tab" });
        assert.equal(tui.input, "open @alpha_helper.js ");

        tui._handleComposerKey("", { name: "backspace", meta: true });
        assert.equal(tui.input, "open ");

        tui.scrollOffset = 5;
        tui._handleComposerKey("", { name: "l", ctrl: true });
        assert.equal(tui.scrollOffset, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("F9: parseArgs handles doctor and --debug, and kovence doctor runs cleanly", () => {
    const opts = parseArgs(["doctor", "--debug"]);
    assert.equal(opts.doctor, true);
    assert.equal(opts.debug, true);

    const out = execFileSync(process.execPath, [path.resolve(__dirname, "..", "nd.js"), "doctor"], {
        encoding: "utf8",
        timeout: 8000,
    });
    assert.match(out, /Kovence Doctor/);
    assert.match(out, /Node\.js/);
});

test("Sessions: groupSessionsByDate omits empty dates, suggestSessionIdFromPrompt creates unique slugs, and picker skips date headers", () => {
    const { tmp, paths } = makeTempPaths();
    try {
        const now = new Date("2026-11-19T12:00:00Z");
        const s1 = createEmptySession("s1", "gpt-4o");
        s1.history.push({ role: "user", content: "Fix auth bug" });
        saveSession(s1, paths);

        const s2 = createEmptySession("s2", "gpt-4o");
        saveSession(s2, paths);
        // Backdate s2 to 2026-11-10
        const s2File = path.join(paths.sessionsDir, "s2.json");
        const s2Data = JSON.parse(fs.readFileSync(s2File, "utf8"));
        s2Data.updatedAt = "2026-11-10T08:00:00.000Z";
        fs.writeFileSync(s2File, JSON.stringify(s2Data, null, 2), "utf8");

        const groups = groupSessionsByDate(listSessions(paths), now);
        assert.equal(groups.length, 2);
        assert.equal(groups[0].dateLabel, "Today (2026-11-19)");
        assert.equal(groups[1].dateLabel, "2026-11-10");

        const slug1 = suggestSessionIdFromPrompt("Fix login bug in auth.js", paths);
        assert.equal(slug1, "fix-login-bug-in-auth-js");
        saveSession(createEmptySession(slug1, "gpt-4o"), paths);
        const slug2 = suggestSessionIdFromPrompt("Fix login bug in auth.js", paths);
        assert.equal(slug2, "fix-login-bug-in-auth-js-2");

        const stdout = new PassThrough();
        stdout.columns = 90;
        stdout.rows = 24;
        const stdin = new PassThrough();
        stdin.setRawMode = () => {};
        const tui = new KovenceTUI({ stdout, stdin });
        tui.openPicker("Sessions", [
            { type: "new", id: "", label: "+ New Session", desc: "" },
            { type: "header", id: "__hdr", label: "Today (2026-11-19)", desc: "1 session(s)" },
            { type: "session", id: "s1", label: "s1", desc: "" },
        ]);
        assert.equal(tui.picker.selIdx, 0);
        tui._handlePickerKey("", { name: "down" });
        assert.equal(tui.picker.selIdx, 2);
        tui._handlePickerKey("", { name: "up" });
        assert.equal(tui.picker.selIdx, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
