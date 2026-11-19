"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CLI_PATH = path.resolve(__dirname, "../nd.js");

function runCli(args, { cwd, env = {}, stdin = null } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI_PATH, ...args], {
            cwd,
            env: { ...process.env, KOVENCE_NO_DOTENV: "1", NO_COLOR: "1", ...env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        if (stdin !== null) child.stdin.write(stdin);
        child.stdin.end();
    });
}

function createMockSseServer() {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        const body = bodyStr ? JSON.parse(bodyStr) : null;
        requests.push({ url: req.url, body });

        if (req.url.endsWith("/models")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
            return;
        }

        // OpenAI /v1/chat/completions mock with tool-call turn -> final turn
        if (req.url.endsWith("/chat/completions")) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            const hasToolResult = Array.isArray(body?.messages) && body.messages.some((m) => m.role === "tool");
            const lastUser = [...(body?.messages || [])].reverse().find((m) => m.role === "user")?.content || "";

            if (!hasToolResult && /TRIGGER_PLAN_WRITE/.test(lastUser)) {
                res.write(
                    `data: ${JSON.stringify({
                        choices: [
                            {
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call_w1",
                                            type: "function",
                                            function: {
                                                name: "write_file",
                                                arguments: JSON.stringify({
                                                    path: "should_not_exist.txt",
                                                    content: "nope",
                                                }),
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
                return;
            }

            if (
                /TRIGGER_RETRY_FAIL/.test(lastUser) &&
                requests.filter((r) => r.url.endsWith("/chat/completions")).length === 1
            ) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Mock bad request" } }));
                return;
            }

            const answer = hasToolResult ? "Plan blocked cleanly as expected." : "Clean Answer Only";
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
            res.write(
                `data: ${JSON.stringify({
                    choices: [{ delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 20, completion_tokens: 5 },
                })}\n\n`
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
        }

        // Anthropic /v1/messages mock
        if (req.url.endsWith("/messages")) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(
                `data: ${JSON.stringify({
                    type: "message_start",
                    message: { usage: { input_tokens: 15, output_tokens: 0 } },
                })}\n\n`
            );
            res.write(
                `data: ${JSON.stringify({
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: "Anthropic Reply OK" },
                })}\n\n`
            );
            res.write(
                `data: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 4 },
                })}\n\n`
            );
            res.end();
            return;
        }

        res.writeHead(404);
        res.end();
    });

    return { server, requests };
}

test("B15: CLI --version, --help, unknown flags, and invalid numeric flags", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-cli-flags-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const ver = await runCli(["--version"], { cwd: tmp });
    assert.equal(ver.code, 0);
    assert.match(ver.stdout, /kovence-cli v\d+\.\d+\.\d+/);

    const unk = await runCli(["--not-a-real-flag"], { cwd: tmp });
    assert.equal(unk.code, 1);
    assert.match(unk.stderr, /Unknown option/i);

    const nanTemp = await runCli(["-t", "notanumber"], { cwd: tmp });
    assert.equal(nanTemp.code, 1);
    assert.match(nanTemp.stderr, /Invalid temperature/i);
});

test("B16 + A2 + D: headless -p stdout/stderr separation, --json, --no-session, and Plan Mode tool blocking via SSE", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-e2e-"));
    const cfgDir = path.join(tmp, "cfg");
    const repoDir = path.join(tmp, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const { server, requests } = createMockSseServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const port = server.address().port;

    const baseEnv = {
        KOVENCE_CONFIG_DIR: cfgDir,
        LITELLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
        LITELLM_API_KEY: "test-key",
        LITELLM_MODEL: "mock-model",
    };

    // 1. Clean -p stdout ONLY + --no-session leaves no session files
    const pRun = await runCli(["-p", "say hello", "--no-session"], { cwd: repoDir, env: baseEnv });
    assert.equal(pRun.code, 0);
    assert.equal(pRun.stdout.trim(), "Clean Answer Only");
    const sessionsDir = path.join(repoDir, ".kovence", "sessions");
    assert.equal(fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).length : 0, 0);

    // 2. --json mode returns valid structured JSON
    const jRun = await runCli(["-p", "say hello", "--json", "--no-session"], { cwd: repoDir, env: baseEnv });
    assert.equal(jRun.code, 0);
    const parsedJson = JSON.parse(jRun.stdout);
    assert.equal(parsedJson.ok, true);
    assert.equal(parsedJson.answer, "Clean Answer Only");

    // 3. Plan mode blocks write_file call sent by SSE model and continues turn
    const planRun = await runCli(["-p", "TRIGGER_PLAN_WRITE", "--mode", "plan"], { cwd: repoDir, env: baseEnv });
    assert.equal(planRun.code, 0);
    assert.equal(fs.existsSync(path.join(repoDir, "should_not_exist.txt")), false);
    assert.match(planRun.stderr, /Plan mode: mutation blocked/i);
    assert.match(planRun.stdout, /Plan blocked cleanly as expected/);
    assert.ok(requests.length >= 2);

    // 4. Launching without --session creates a new isolated session each time; --session loads an existing one
    const runA = await runCli(["-p", "say hello", "--json"], { cwd: repoDir, env: baseEnv });
    const runB = await runCli(["-p", "say hello", "--json"], { cwd: repoDir, env: baseEnv });
    const sessA = JSON.parse(runA.stdout).sessionId;
    const sessB = JSON.parse(runB.stdout).sessionId;
    assert.notEqual(sessA, "default");
    assert.notEqual(sessB, "default");
    assert.notEqual(sessA, sessB);

    const runResume = await runCli(["-p", "say hello", "--session", sessA, "--json"], { cwd: repoDir, env: baseEnv });
    assert.equal(JSON.parse(runResume.stdout).sessionId, sessA);
});

test("D: Anthropic provider SSE flow works end-to-end via providers.json", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-ant-e2e-"));
    const cfgDir = path.join(tmp, "cfg");
    const repoDir = path.join(tmp, "repo");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const { server } = createMockSseServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const port = server.address().port;

    fs.writeFileSync(
        path.join(cfgDir, "providers.json"),
        JSON.stringify({
            active: "ant",
            providers: {
                ant: {
                    name: "ant",
                    type: "anthropic",
                    baseUrl: `http://127.0.0.1:${port}/v1`,
                    apiKey: "ant-key",
                    defaultModel: "claude-mock",
                },
            },
        }),
        "utf8"
    );

    const antRun = await runCli(["-p", "hi anthropic", "--no-session"], {
        cwd: repoDir,
        env: { KOVENCE_CONFIG_DIR: cfgDir },
    });
    assert.equal(antRun.code, 0);
    assert.equal(antRun.stdout.trim(), "Anthropic Reply OK");
});
