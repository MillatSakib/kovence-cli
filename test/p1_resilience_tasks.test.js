"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { repairToolArguments, LoopDetector } = require("../src/agent/resilience");
const { lookupModelCapabilities, estimateTokenCostUsd } = require("../src/config/model_registry");
const { BackgroundTaskManager } = require("../src/tools/tasks");
const { executeTool } = require("../tools");
const { handleSlash } = require("../src/commands/handlers");

test("repairToolArguments repairs fenced, trailing-comma, and truncated JSON", () => {
    assert.deepEqual(repairToolArguments('```json\n{"path": "a.js",}\n```'), { path: "a.js" });
    assert.deepEqual(repairToolArguments('{path: "b.js", count: 2}'), { path: "b.js", count: 2 });
    assert.deepEqual(repairToolArguments('{"path": "c.js"'), { path: "c.js" });
});

test("LoopDetector triggers only on consecutive identical tool calls", () => {
    const det = new LoopDetector(3);
    const callA = [{ function: { name: "read_file", arguments: '{"path":"a.js"}' } }];
    const callB = [{ function: { name: "read_file", arguments: '{"path":"b.js"}' } }];

    assert.equal(det.record(callA).repeated, false);
    assert.equal(det.record(callA).repeated, false);
    const third = det.record(callA);
    assert.equal(third.repeated, true);
    assert.equal(third.count, 3);

    assert.equal(det.record(callB).repeated, false);
});

test("model_registry detects reasoning models without temperature and estimates cost", () => {
    const o3 = lookupModelCapabilities("openai/o3-mini");
    assert.equal(o3.supportsTemperature, false);
    assert.ok(o3.contextWindow >= 128000);

    const sonnet = lookupModelCapabilities("claude-sonnet-4");
    assert.equal(sonnet.supportsTemperature, true);
    assert.equal(sonnet.contextWindow, 200000);

    const cost = estimateTokenCostUsd("gpt-4o", 1_000_000, 1_000_000);
    assert.equal(cost.knownPricing, true);
    assert.ok(cost.totalUsd > 0);
});

test("BackgroundTaskManager starts, lists, logs, and kills detached processes + /tasks", async () => {
    const mgr = new BackgroundTaskManager();
    const out = await executeTool(
        "run_command",
        { command: "echo bg-ok && sleep 5", background: true },
        { workspaceRoot: process.cwd(), bgTasks: mgr, settings: { agentMode: "auto" } }
    );
    assert.match(out, /Started background task 1/);

    const list = mgr.listTasks();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "1");

    const logs = [];
    const sink = {
        log: (_kind, msg) => logs.push(msg),
        syncStatus: () => {},
        clear: () => {},
    };
    await handleSlash({ bgTasks: mgr }, "/tasks", sink);
    assert.ok(logs.some((m) => m.includes("1 · [running]")));

    await handleSlash({ bgTasks: mgr }, "/tasks kill 1", sink);
    assert.ok(logs.some((m) => m.includes("Killed background task 1")));
    mgr.killAll();
});
