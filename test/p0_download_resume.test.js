"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { downloadResumable } = require("../src/tools/download");

const FAST = { allowPrivate: true, retryBaseDelayMs: 15, connectTimeoutMs: 2000 };

function makeTmp(t) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-resume-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    return tmp;
}

async function listen(t, handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, range: req.headers.range || "", acceptEncoding: req.headers["accept-encoding"] });
        handler(req, res, requests.length);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => {
        server.closeAllConnections?.();
        server.close();
    });
    return { url: `http://127.0.0.1:${server.address().port}/file.bin`, requests };
}

function serveRange(payload, req, res) {
    const m = /bytes=(\d+)-/.exec(req.headers.range || "");
    if (m) {
        const start = Number(m[1]);
        res.writeHead(206, {
            "Content-Length": String(payload.length - start),
            "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
            ETag: '"v1"',
        });
        res.end(payload.subarray(start));
    } else {
        res.writeHead(200, { "Content-Length": String(payload.length), ETag: '"v1"' });
        res.end(payload);
    }
}

test("download resumes with Range after the connection drops mid-transfer", async (t) => {
    const tmp = makeTmp(t);
    const payload = crypto.randomBytes(600 * 1024);
    const { url, requests } = await listen(t, (req, res, n) => {
        if (n === 1) {
            res.writeHead(200, { "Content-Length": String(payload.length), ETag: '"v1"' });
            res.write(payload.subarray(0, 200 * 1024), () => setTimeout(() => res.socket.destroy(), 40));
            return;
        }
        serveRange(payload, req, res);
    });

    const dest = path.join(tmp, "out.bin");
    const updates = [];
    const result = await downloadResumable(url, dest, { ...FAST, onProgress: (i) => updates.push(i) });

    assert.deepEqual(fs.readFileSync(dest), payload);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.equal(requests.length, 2);
    assert.match(requests[1].range, /^bytes=\d+-$/);
    assert.equal(requests[0].acceptEncoding, "identity");
    assert.equal(result.resumed, true);
    assert.ok(updates.some((u) => u.status === "retrying"));
    assert.equal(updates[updates.length - 1].percent, 100);
});

test("stalled connection is detected by idle timeout and resumed", async (t) => {
    const tmp = makeTmp(t);
    const payload = crypto.randomBytes(300 * 1024);
    const { url, requests } = await listen(t, (req, res, n) => {
        if (n === 1) {
            res.writeHead(200, { "Content-Length": String(payload.length) });
            res.write(payload.subarray(0, 50 * 1024)); // then hang forever
            return;
        }
        serveRange(payload, req, res);
    });

    const dest = path.join(tmp, "stall.bin");
    await downloadResumable(url, dest, { ...FAST, idleTimeoutMs: 300 });
    assert.deepEqual(fs.readFileSync(dest), payload);
    assert.equal(requests.length, 2);
});

test("temporary 503 is retried and 404 fails immediately without retry", async (t) => {
    const tmp = makeTmp(t);
    const payload = crypto.randomBytes(64 * 1024);
    const flaky = await listen(t, (req, res, n) => {
        if (n <= 2) {
            res.writeHead(503);
            res.end("busy");
            return;
        }
        serveRange(payload, req, res);
    });
    await downloadResumable(flaky.url, path.join(tmp, "flaky.bin"), FAST);
    assert.equal(flaky.requests.length, 3);

    const missing = await listen(t, (req, res) => {
        res.writeHead(404);
        res.end("nope");
    });
    await assert.rejects(() => downloadResumable(missing.url, path.join(tmp, "missing.bin"), FAST), /HTTP 404/);
    assert.equal(missing.requests.length, 1);
    assert.equal(fs.existsSync(path.join(tmp, "missing.bin")), false);
});

test("server that ignores Range restarts cleanly instead of corrupting the file", async (t) => {
    const tmp = makeTmp(t);
    const payload = crypto.randomBytes(400 * 1024);
    const { url } = await listen(t, (req, res, n) => {
        res.writeHead(200, { "Content-Length": String(payload.length) });
        if (n === 1) {
            res.write(payload.subarray(0, 100 * 1024), () => setTimeout(() => res.socket.destroy(), 40));
            return;
        }
        res.end(payload); // always full body, ignores Range
    });
    const dest = path.join(tmp, "norange.bin");
    await downloadResumable(url, dest, FAST);
    assert.deepEqual(fs.readFileSync(dest), payload);
});

test("existing .part file from an earlier failed run is resumed on the next call", async (t) => {
    const tmp = makeTmp(t);
    const payload = crypto.randomBytes(256 * 1024);
    const { url, requests } = await listen(t, (req, res) => serveRange(payload, req, res));
    const dest = path.join(tmp, "prev.bin");
    fs.writeFileSync(`${dest}.part`, payload.subarray(0, 100 * 1024));

    const result = await downloadResumable(url, dest, FAST);
    assert.deepEqual(fs.readFileSync(dest), payload);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].range, `bytes=${100 * 1024}-`);
    assert.equal(result.resumed, true);
});

test("SHA-256 mismatch removes the corrupt file, correct digest passes", async (t) => {
    const tmp = makeTmp(t);
    const payload = crypto.randomBytes(32 * 1024);
    const { url } = await listen(t, (req, res) => serveRange(payload, req, res));
    const good = crypto.createHash("sha256").update(payload).digest("hex");

    const destOk = path.join(tmp, "ok.bin");
    const ok = await downloadResumable(url, destOk, { ...FAST, sha256: good });
    assert.equal(ok.verified, true);

    const destBad = path.join(tmp, "bad.bin");
    await assert.rejects(() => downloadResumable(url, destBad, { ...FAST, sha256: "00".repeat(32) }), /SHA-256 mismatch/);
    assert.equal(fs.existsSync(destBad), false);
    assert.equal(fs.existsSync(`${destBad}.part`), false);
});

test("user cancel keeps the partial file for resume and SSRF redirect to private IP is blocked", async (t) => {
    const tmp = makeTmp(t);
    const payload = crypto.randomBytes(200 * 1024);
    const { url } = await listen(t, (req, res) => {
        res.writeHead(200, { "Content-Length": String(payload.length) });
        res.write(payload.subarray(0, 64 * 1024)); // hang after partial
    });
    const ctl = new AbortController();
    const dest = path.join(tmp, "cancel.bin");
    setTimeout(() => ctl.abort(), 250);
    await assert.rejects(() => downloadResumable(url, dest, { ...FAST, signal: ctl.signal }), /cancelled/i);
    assert.ok(fs.statSync(`${dest}.part`).size > 0);

    // Public (non-allowPrivate) call to loopback must be refused before any request
    await assert.rejects(
        () => downloadResumable(url, path.join(tmp, "ssrf.bin"), { retryBaseDelayMs: 10 }),
        /SSRF blocked/
    );
});
