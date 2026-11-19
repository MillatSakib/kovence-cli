"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const readline = require("node:readline");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { KovenceTUI } = require("../tui");
const { runAgentTurn } = require("../src/agent/turn");
const { resolvePaths } = require("../src/config/paths");

function createWiredTui(handlers = {}) {
    const stdout = new EventEmitter();
    stdout.columns = 100;
    stdout.rows = 24;
    stdout.isTTY = true;
    stdout.write = () => true;

    const stdin = new EventEmitter();
    stdin.isTTY = false;

    const tui = new KovenceTUI({ stdout, stdin, ...handlers });
    tui.active = true;
    tui.keyStream = new PassThrough();
    readline.emitKeypressEvents(tui.keyStream);
    tui.keyStream.on("keypress", tui.onKey);
    return tui;
}

test("Kitty CSI-u Ctrl+C, modifyOtherKeys Ctrl+C, legacy Ctrl+C, and Esc cancel busy tasks and exit reliably", async () => {
    let cancels = 0;
    let exits = 0;
    const tui = createWiredTui({
        onCancel: () => {
            cancels += 1;
        },
        onExit: () => {
            exits += 1;
        },
    });

    // Busy state: Kitty CSI-u Ctrl+C (\x1b[99;5u) cancels task on first press
    tui.setStatus({ isBusy: true, busyLabel: "Downloading..." });
    tui.onRawData(Buffer.from("\x1b[99;5u"));
    await new Promise((r) => setImmediate(r));
    assert.equal(cancels, 1);
    assert.equal(exits, 0);

    // Second Ctrl+C (modifyOtherKeys \x1b[27;5;99~) within 2.5s exits CLI immediately
    tui.onRawData(Buffer.from("\x1b[27;5;99~"));
    await new Promise((r) => setImmediate(r));
    assert.equal(exits, 1);

    // Idle state: single legacy Ctrl+C (\x03) exits CLI immediately
    tui.setStatus({ isBusy: false, busyLabel: "" });
    tui.onRawData(Buffer.from("\x03"));
    await new Promise((r) => setImmediate(r));
    assert.equal(exits, 2);

    // Modal open during task: Ctrl+C closes modal AND calls onCancel
    tui.setStatus({ isBusy: true, busyLabel: "Running tools..." });
    tui.lastCtrlCAt = 0;
    const modalPromise = tui.askModal("Allow run_command? [y/n]: ");
    tui.onRawData(Buffer.from("\x1b[99;5u"));
    const modalVal = await modalPromise;
    assert.equal(modalVal, "");
    assert.equal(cancels, 2);
});

test("runAgentTurn keeps state.activeAbort alive during tool execution and aborts sleep 30 in < 1s", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-abort-tool-"));
    const cfgDir = path.join(tmp, "cfg");
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    // Mock OpenAI server that triggers a slow run_command("sleep 30")
    const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
            `data: ${JSON.stringify({
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_sleep",
                                    type: "function",
                                    function: {
                                        name: "run_command",
                                        arguments: JSON.stringify({ command: "sleep 30", timeout_ms: 30000 }),
                                    },
                                },
                            ],
                        },
                    },
                ],
            })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());

    const paths = resolvePaths({
        cwd: tmp,
        projectRoot: tmp,
        globalDir: cfgDir,
        projectDir: path.join(tmp, ".kovence"),
    });
    const state = {
        paths,
        workspaceRoot: tmp,
        extraDirs: [],
        noSession: true,
        provider: {
            name: "mock",
            type: "openai",
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: "k",
        },
        model: "mock-m",
        settings: {
            agentMode: "auto",
            toolPermission: "always-proceed",
            toolsEnabled: true,
            maxToolSteps: 5,
            contextWindow: 32000,
            systemPrompt: "test",
        },
        session: {
            id: "default",
            history: [],
            pinnedMemory: [],
            todos: [],
            stats: { requests: 0, totalMs: 0, promptTokens: 0, completionTokens: 0 },
        },
        sessionRules: [],
        capabilities: { _byModel: new Map() },
        sudoPasswords: new Map(),
        activeAbort: null,
        lastFailedPrompt: "",
        isDownloading: false,
    };

    let toolStartedAt = 0;
    const sink = {
        interactive: false,
        log: (kind, text) => {
            if (kind === "tool" && text.includes("run_command")) {
                toolStartedAt = Date.now();
                // Abort active task 150ms AFTER run_command has started
                setTimeout(() => {
                    assert.ok(state.activeAbort, "state.activeAbort must remain non-null while tool is executing");
                    state.activeAbort.abort();
                }, 150);
            }
        },
        setBusy: () => {},
        syncStatus: () => {},
        startThinking: () => ({ stop() {}, write() {}, end() {} }),
    };

    await assert.rejects(
        () => runAgentTurn(state, "run slow sleep", sink),
        (err) => err.name === "AbortError" || err.aborted
    );
    assert.ok(toolStartedAt > 0);
    const elapsedAfterStart = Date.now() - toolStartedAt;
    assert.ok(elapsedAfterStart < 1200, `Expected abort within 1.2s of tool start, took ${elapsedAfterStart}ms`);
    assert.equal(state.activeAbort, null);
    assert.equal(state.lastFailedPrompt, "run slow sleep");
});

test("Esc clears /command input immediately and Ctrl+C cancel restores active + queued prompts with newlines", async () => {
    const state = {
        isBusy: true,
        activePrompt: "fix the login bug",
        queue: ["add unit tests", "update readme"],
    };
    const slashExecutedWhileBusy = [];

    const tui = createWiredTui({
        onSubmit(raw) {
            if (raw.startsWith("/")) {
                slashExecutedWhileBusy.push(raw);
                return;
            }
            if (state.isBusy) {
                state.queue.push(raw);
                tui.addBlock("queued", `[Queued #${state.queue.length}] ${raw}`);
            }
        },
        onCancel() {
            const parts = [];
            if (state.activePrompt) {
                parts.push(state.activePrompt);
                state.activePrompt = "";
            }
            if (state.queue.length) {
                parts.push(...state.queue);
                state.queue.length = 0;
            }
            if (tui.input && tui.input.trim()) {
                parts.push(tui.input);
            }
            if (parts.length) {
                tui.setInput(parts.join("\n"));
            }
            tui.removeQueuedBlocks();
        },
    });
    tui.setStatus({ isBusy: true, busyLabel: "Thinking..." });
    tui.addBlock("queued", "[Queued #1] add unit tests");
    tui.addBlock("queued", "[Queued #2] update readme");

    // 1. Typing a /command and pressing Esc (both Kitty \x1b[27u and raw \x1b) clears input immediately
    tui.setInput("/settings");
    assert.equal(tui.input, "/settings");
    tui.onRawData(Buffer.from("\x1b[27u"));
    assert.equal(tui.input, "");
    assert.equal(tui.cursor, 0);

    tui.setInput("/model gpt-4");
    tui.onRawData(Buffer.from("\x1b"));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(tui.input, "");

    // 2. Submitting a /command while busy executes immediately instead of queueing
    tui.setInput("/stats");
    tui.onKey("", { name: "return" });
    assert.deepEqual(slashExecutedWhileBusy, ["/stats"]);
    assert.equal(state.queue.includes("/stats"), false);

    // 3. Pressing Ctrl+C while busy cancels task and restores activePrompt + queue separated by '\n' into composer input
    tui.onRawData(Buffer.from("\x1b[99;5u"));
    await new Promise((r) => setImmediate(r));
    assert.equal(tui.input, "fix the login bug\nadd unit tests\nupdate readme");
    assert.equal(tui.cursor, tui.input.length);
    assert.equal(state.queue.length, 0);
    assert.equal(
        tui.blocks.some((b) => b.kind === "queued"),
        false
    );
});
