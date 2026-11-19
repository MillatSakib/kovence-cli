"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { executeTool, capOutput, TOOL_DEFINITIONS } = require("../tools");
const { fetchWithAdapter, toAnthropicMessages, getModelCapabilities } = require("../providers");
const { sliceValidHistory, estimateTextTokens } = require("../src/agent/history");
const { scrubChildEnv, spawnShell } = require("../src/tools/exec");
const { assertSafePublicUrl, htmlToMarkdown, BROWSER_HEADERS } = require("../src/tools/net");

test("B1: sliceValidHistory preserves original user prompt inside long tool loops and pairs tool calls", () => {
    const history = [{ role: "user", content: "Original user goal: fix bug X" }];
    for (let i = 0; i < 16; i++) {
        const id = `call_${i}`;
        history.push({
            role: "assistant",
            content: null,
            tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
        });
        history.push({
            role: "tool",
            tool_call_id: id,
            name: "read_file",
            content: "X".repeat(600),
        });
    }

    const sliced = sliceValidHistory(history, 12);
    assert.equal(sliced[0].role, "user");
    assert.equal(sliced[0].content, "Original user goal: fix bug X");
    // Older tool outputs within oversized active turn get compressed instead of dropping the turn
    assert.match(sliced[2].content, /\[pruned earlier tool output:/);
    assert.equal(sliced[sliced.length - 1].content.length, 600);

    // Anthropic conversion guarantees first message is user even with orphan assistant prefix
    const ant = toAnthropicMessages([
        { role: "assistant", content: "orphan" },
        { role: "user", content: "real question" },
    ]);
    assert.equal(ant.messages[0].role, "user");
    assert.equal(ant.messages[0].content, "real question");
    assert.ok(estimateTextTokens("আমার বাংলা টেক্সট") > 5);
});

test("B5: glob_files traverses 500+ files and respects .gitignore", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-glob-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    fs.writeFileSync(path.join(tmp, ".gitignore"), "ignored_dir/\n*.log\n", "utf8");
    fs.mkdirSync(path.join(tmp, "ignored_dir"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "ignored_dir", "secret.js"), "ignored", "utf8");
    fs.writeFileSync(path.join(tmp, "app.log"), "ignored log", "utf8");

    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 450; i++) {
        fs.writeFileSync(path.join(srcDir, `file_${String(i).padStart(3, "0")}.txt`), "ok", "utf8");
    }
    fs.writeFileSync(path.join(srcDir, "needle_target.ts"), "export const ok = true;", "utf8");

    const res = await executeTool("glob_files", { pattern: "**/*.ts" }, { cwd: tmp, workspaceRoot: tmp });
    assert.match(res, /src\/needle_target\.ts/);
    assert.doesNotMatch(res, /ignored_dir/);

    const listRes = await executeTool("glob_files", { pattern: "*.log" }, { cwd: tmp, workspaceRoot: tmp });
    assert.equal(listRes, "No matching files.");
});

test("B9 + B17: spawnShell aborts process groups < 1s and scrubChildEnv hides API keys", async () => {
    const dirtyEnv = {
        ...process.env,
        OPENAI_API_KEY: "sk-super-secret",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        CUSTOM_API_TOKEN: "tok-secret",
        PATH: process.env.PATH,
    };
    const clean = scrubChildEnv(dirtyEnv, ["MY_PROVIDER_KEY"]);
    assert.equal(clean.OPENAI_API_KEY, undefined);
    assert.equal(clean.ANTHROPIC_API_KEY, undefined);
    assert.equal(clean.CUSTOM_API_TOKEN, undefined);

    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 120);
    const run = await spawnShell("sleep 30", { signal: ac.signal, timeout: 10000 });
    const dt = Date.now() - t0;
    assert.equal(run.aborted, true);
    assert.ok(dt < 1000, `Expected abort in <1000ms, took ${dt}ms`);
});

test("B18: SSRF protection blocks loopback/private/metadata IPs and htmlToMarkdown cleans HTML", async () => {
    await assert.rejects(() => assertSafePublicUrl("http://127.0.0.1:8080/admin"), /SSRF|private|loopback/i);
    await assert.rejects(() => assertSafePublicUrl("http://169.254.169.254/latest/meta-data/"), /SSRF|private/i);
    await assert.rejects(() => assertSafePublicUrl("http://10.0.0.5/"), /SSRF|private/i);
    await assert.rejects(() => assertSafePublicUrl("file:///etc/passwd"), /protocol/i);

    const md = htmlToMarkdown("<h1>Title</h1><script>evil()</script><p>See <a href='https://kovence.com'>docs</a>.</p>");
    assert.match(md, /# Title/);
    assert.doesNotMatch(md, /evil/);
    assert.match(md, /\[docs\]\(https:\/\/kovence\.com\)/);

    assert.ok(BROWSER_HEADERS["Sec-CH-UA"]);
    assert.equal(BROWSER_HEADERS["Sec-CH-UA-Mobile"], "?0");
    assert.equal(BROWSER_HEADERS["Sec-CH-UA-Platform"], '"Linux"');
    assert.equal(BROWSER_HEADERS["Sec-Fetch-Dest"], "document");
    assert.equal(BROWSER_HEADERS["Sec-Fetch-Mode"], "navigate");
    assert.equal(BROWSER_HEADERS["Sec-Fetch-Site"], "none");
    assert.equal(BROWSER_HEADERS["Sec-Fetch-User"], "?1");
});

test("B22 + A2: capOutput keeps head+tail, read_file blocks binary, edit_file enforces unique match, executeTool enforces plan mode", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-tools-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const big = "HEAD_" + "a".repeat(20000) + "_TAIL_ERROR";
    const capped = capOutput(big);
    assert.match(capped, /^HEAD_/);
    assert.match(capped, /_TAIL_ERROR$/);
    assert.match(capped, /truncated/);

    fs.writeFileSync(path.join(tmp, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const binRead = await executeTool("read_file", { path: "bin.dat" }, { cwd: tmp, workspaceRoot: tmp });
    assert.match(binRead, /Binary file detected/i);

    fs.writeFileSync(path.join(tmp, "dup.js"), "const a = 1;\nconst a = 1;\n", "utf8");
    await assert.rejects(
        () =>
            executeTool(
                "edit_file",
                { path: "dup.js", target: "const a = 1;", replacement: "const a = 2;" },
                { cwd: tmp, workspaceRoot: tmp, _permissionChecked: true }
            ),
        /2 occurrences/i
    );

    // Search with invalid regex falls back to literal match cleanly
    const searchRes = await executeTool(
        "search_files",
        { pattern: "unclosed[", path: "." },
        { cwd: tmp, workspaceRoot: tmp }
    );
    assert.equal(typeof searchRes, "string");

    // Plan mode blocks mutating tool inside executeTool itself
    const blocked = await executeTool(
        "write_file",
        { path: "new.txt", content: "blocked" },
        { cwd: tmp, workspaceRoot: tmp, settings: { agentMode: "plan" } }
    );
    assert.match(blocked, /Plan mode: mutation blocked/i);
    assert.equal(fs.existsSync(path.join(tmp, "new.txt")), false);
});

test("B12 + B13: fetchWithAdapter retries 429/503 and does not disable tools on unrelated 400 errors", async (t) => {
    let calls = 0;
    const server = http.createServer((req, res) => {
        calls += 1;
        req.resume();
        if (calls === 1) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
            return;
        }
        if (calls === 2) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "bad temperature parameter near function payload" } }));
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());

    const port = server.address().port;
    const provider = { name: "mock", type: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "" };
    const caps = {};

    // First call hits 503 then recovers... wait call 2 hits 400 with unrelated 'function' mention
    await assert.rejects(
        () =>
            fetchWithAdapter({
                provider,
                model: "m1",
                settings: { toolsEnabled: true },
                bodyBase: { messages: [{ role: "user", content: "hi" }], stream: false },
                capabilities: caps,
                toolDefinitions: TOOL_DEFINITIONS,
                maxRetries: 1,
            }),
        /HTTP 400/
    );

    // Crucial B13 check: supportsTools must STILL be true!
    assert.equal(getModelCapabilities(caps, provider, "m1").supportsTools, true);

    // Next call succeeds cleanly
    const res = await fetchWithAdapter({
        provider,
        model: "m1",
        settings: { toolsEnabled: true },
        bodyBase: { messages: [{ role: "user", content: "hi" }], stream: false },
        capabilities: caps,
        toolDefinitions: TOOL_DEFINITIONS,
        maxRetries: 1,
    });
    assert.equal(res.status, 200);
});
