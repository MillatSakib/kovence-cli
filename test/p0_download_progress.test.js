"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { formatDownloadProgress, formatNetworkError } = require("../src/tools/net");
const { streamDownloadSafe } = require("../src/tools/download");
const { wrapPlain, stripAnsi } = require("../src/tui/text_width");
const { KovenceTUI } = require("../tui");
const { EventEmitter } = require("node:events");
const { runToolCalls } = require("../src/agent/turn");
const { resolvePaths } = require("../src/config/paths");

test("Download progress formatter displays bar, percentage, bytes, speed, and ETA", () => {
    const line = formatDownloadProgress({
        filename: "installer.deb",
        bytes: 5 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024,
        bytesPerSec: 2 * 1024 * 1024,
        etaSec: 2.5,
    });
    assert.match(line, /installer\.deb/);
    assert.match(line, /\[█{10}░{10}\]/);
    assert.match(line, /50\.0%/);
    assert.match(line, /2\.00 MB\/s/);
    assert.match(line, /ETA 3s/);

    const unknownSize = formatDownloadProgress({
        filename: "stream.tar.gz",
        bytes: 1024 * 512,
        totalBytes: 0,
        bytesPerSec: 256 * 1024,
    });
    assert.match(unknownSize, /stream\.tar\.gz/);
    assert.match(unknownSize, /256\.0 KB\/s/);
});

test("streamDownloadSafe emits throttled progress callbacks and final 100% completion", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-dl-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const payload = Buffer.alloc(128 * 1024, 65);
    const server = http.createServer((req, res) => {
        res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(payload.length),
        });
        res.end(payload);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());

    const dest = path.join(tmp, "pkg.bin");
    const updates = [];
    const res = await streamDownloadSafe(`http://127.0.0.1:${server.address().port}/pkg.bin`, dest, {
        allowPrivate: true,
        onProgress: (info) => updates.push(info),
    });

    assert.equal(res.bytes, payload.length);
    assert.equal(fs.readFileSync(dest).length, payload.length);
    assert.ok(updates.length >= 2);
    assert.equal(updates[updates.length - 1].percent, 100);
});

test("runToolCalls flushes parallel reads before download and skips dependent run_command if download is denied", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-dl-lock-"));
    const cfgDir = path.join(tmp, "cfg");
    fs.writeFileSync(path.join(tmp, "info.txt"), "hello world\n", "utf8");
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const paths = resolvePaths({ cwd: tmp, projectRoot: tmp, globalDir: cfgDir, projectDir: path.join(tmp, ".kovence") });
    const logs = [];
    const sink = {
        interactive: false,
        log: (kind, text) => logs.push({ kind, text }),
        setBusy: () => {},
        syncStatus: () => {},
        startProgress: () => ({ update() {}, done() {} }),
    };

    const state = {
        paths,
        workspaceRoot: tmp,
        extraDirs: [],
        settings: { agentMode: "default", toolPermission: "ask", nonWorkspaceAccess: "ask" },
        session: { id: "default", history: [], pinnedMemory: [], todos: [], stats: {} },
        sessionRules: [],
        sudoPasswords: new Map(),
        isDownloading: false,
    };

    const toolCalls = [
        { id: "c1", function: { name: "read_file", arguments: JSON.stringify({ path: "info.txt" }) } },
        { id: "c2", function: { name: "download_file", arguments: JSON.stringify({ url: "http://127.0.0.1:9/a.deb" }) } },
        { id: "c3", function: { name: "run_command", arguments: JSON.stringify({ command: "echo SHOULD_NOT_RUN" }) } },
    ];

    const res = await runToolCalls(state, toolCalls, sink);
    assert.match(res[0].content, /hello world/);
    assert.match(res[1].content, /Denied:/);
    assert.equal(fs.existsSync(path.join(tmp, "SHOULD_NOT_RUN")), false);

    // Also test explicit Download cancelled barrier when auto mode skips confirmation but cancel happens in askPrompt
    state.settings.agentMode = "auto";
    state.settings.toolPermission = "always-proceed";
    const interactiveSink = {
        ...sink,
        interactive: true,
        confirm: async () => "y",
        askPrompt: async () => "n",
    };
    const res2 = await runToolCalls(state, [toolCalls[1], toolCalls[2]], interactiveSink);
    assert.match(res2[0].content, /SSRF blocked|Download cancelled/);
    assert.match(res2[1].content, /Skipped command because the preceding download did not complete/);
});

test("AggregateError formatting never returns blank and long modal/permission prompts wrap cleanly within cols", () => {
    const agg = new AggregateError(
        [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }), Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" })],
        ""
    );
    const formatted = formatNetworkError(agg);
    assert.ok(formatted.length > 0);
    assert.match(formatted, /ETIMEDOUT/);

    const wrappedUrl = wrapPlain(
        "URL: http://mirrors.kernel.org/ubuntu/pool/universe/q/qbittorrent/qbittorrent_4.6.3-1build2_amd64.deb",
        56
    );
    assert.ok(wrappedUrl.every((l) => l.length <= 56));

    // Render long modal prompt on narrow 80-col TUI: no single rendered box line may exceed 80 visible cols
    const chunks = [];
    const stdout = new EventEmitter();
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.isTTY = true;
    stdout.write = (s) => chunks.push(String(s));
    const stdin = new EventEmitter();
    stdin.isTTY = false;

    const tui = new KovenceTUI({ stdout, stdin });
    tui.active = true;
    tui.askModal(
        "Download 'qbittorrent_4.6.3-1build2_amd64.deb' to '/home/sakib/Downloads/qbittorrent_4.6.3-1build2_amd64.deb'? [y=Downloads / c=custom / n=cancel]: ",
        false
    );
    tui.render();
    const lines = stripAnsi(chunks.join("")).split("\n");
    for (const ln of lines) {
        assert.ok(ln.length <= 80, `Rendered line overflowed 80 cols (${ln.length}): ${ln}`);
    }
});
