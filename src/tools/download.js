"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { BROWSER_HEADERS, assertSafePublicUrl, formatNetworkError } = require("./net");

/**
 * Robust resumable downloader:
 * - writes to `<dest>.part` and atomically renames only after size/checksum verification
 * - resumes with HTTP Range (+If-Range) after any drop, stall, 5xx/429 or reconnect
 * - separate connect timeout and idle (stall) timeout instead of one fixed total timeout
 * - jittered exponential backoff, IPv4 fallback, attempts only count when no progress was made
 * - SSRF re-validation on every redirect hop, identity encoding so sizes stay exact
 */

const RETRYABLE_CODES = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENETDOWN",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_SOCKET",
    "ERR_STREAM_PREMATURE_CLOSE",
]);

const DEFAULTS = {
    maxAttempts: 8,
    connectTimeoutMs: 20000,
    idleTimeoutMs: 45000,
    retryBaseDelayMs: 1000,
    maxRedirects: 8,
    maxBytes: 10 * 1024 * 1024 * 1024,
};

class DownloadError extends Error {
    constructor(message, { retryable = false, aborted = false, resetPart = false, retryAfterMs = 0, phase = "", code = "" } = {}) {
        super(message);
        this.name = "DownloadError";
        this.retryable = retryable;
        this.aborted = aborted;
        this.resetPart = resetPart;
        this.retryAfterMs = retryAfterMs;
        this.phase = phase;
        this.code = code;
    }
}

function wrapNetworkError(err, phase = "") {
    if (err instanceof DownloadError) return err;
    const inner = Array.isArray(err?.errors) ? err.errors : [];
    const codes = [err?.code, ...inner.map((e) => e?.code)].filter(Boolean);
    const message = formatNetworkError(err);
    const retryable =
        codes.some((c) => RETRYABLE_CODES.has(c)) ||
        /timed out|socket hang up|reset|closed|aborted|premature|network|EAI_AGAIN|ENETUNREACH/i.test(message);
    return new DownloadError(message, { retryable, phase, code: codes[0] || "" });
}

function isRetryable(err) {
    if (err instanceof DownloadError) return err.retryable && !err.aborted;
    return /DNS resolution failed/i.test(err?.message || "");
}

function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DownloadError("Download aborted by user", { aborted: true }));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DownloadError("Download aborted by user", { aborted: true }));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function statSize(file) {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

function closeFile(file) {
    if (!file) return Promise.resolve();
    if (file._kovenceClose) return file._kovenceClose;
    file._kovenceClose = new Promise((resolve) => {
        if (file.closed) return resolve();
        file.once("close", resolve);
        file.once("error", () => resolve());
        try {
            file.end();
        } catch {
            resolve();
        }
    });
    return file._kovenceClose;
}

/**
 * Issue one GET and resolve once response headers arrive (connect timeout enforced).
 */
function requestOnce(parsed, { headers, family, connectTimeoutMs, signal }) {
    return new Promise((resolve, reject) => {
        const client = parsed.protocol === "https:" ? https : http;
        const req = client.request(parsed, {
            method: "GET",
            headers,
            autoSelectFamily: true,
            autoSelectFamilyAttemptTimeout: 3000,
            ...(family ? { family } : {}),
        });
        const connTimer = setTimeout(() => {
            req.destroy(
                new DownloadError(`Connection timed out after ${Math.round(connectTimeoutMs / 1000)}s`, {
                    retryable: true,
                    phase: "connect",
                    code: "ETIMEDOUT",
                })
            );
        }, connectTimeoutMs);

        const onAbort = () => req.destroy(signal.reason || new DownloadError("Download aborted by user", { aborted: true }));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

        req.on("response", (res) => {
            clearTimeout(connTimer);
            resolve({ res, req });
        });
        req.on("error", (err) => {
            clearTimeout(connTimer);
            signal?.removeEventListener("abort", onAbort);
            reject(wrapNetworkError(err, "connect"));
        });
        req.end();
    });
}

/**
 * Follow redirects manually so every hop passes SSRF validation.
 */
async function openResponse(startUrl, { headers, family, connectTimeoutMs, signal, allowPrivate, maxRedirects }) {
    let current = startUrl;
    let hopHeaders = headers;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const parsed = await assertSafePublicUrl(current, allowPrivate);
        const { res } = await requestOnce(parsed, { headers: hopHeaders, family, connectTimeoutMs, signal });
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            const next = new URL(res.headers.location, current).toString();
            hopHeaders = { ...hopHeaders, Referer: current };
            current = next;
            continue;
        }
        return { res, finalUrl: current };
    }
    throw new DownloadError("Too many redirects", { retryable: false });
}

function checkDiskSpace(destDir, remainingBytes) {
    if (!remainingBytes || typeof fs.statfsSync !== "function") return;
    try {
        const st = fs.statfsSync(destDir);
        const free = st.bavail * st.bsize;
        if (free < remainingBytes + 16 * 1024 * 1024) {
            throw new DownloadError(
                `Not enough disk space in ${destDir}: need ~${Math.ceil(remainingBytes / 1048576)} MB, free ${Math.floor(free / 1048576)} MB`,
                { retryable: false }
            );
        }
    } catch (err) {
        if (err instanceof DownloadError) throw err;
    }
}

function hashFile(file, algorithm = "sha256") {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algorithm);
        fs.createReadStream(file)
            .on("data", (c) => hash.update(c))
            .on("error", reject)
            .on("end", () => resolve(hash.digest("hex")));
    });
}

function moveFile(from, to) {
    try {
        fs.renameSync(from, to);
    } catch (err) {
        if (err.code !== "EXDEV") throw err;
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
    }
}

/**
 * Download with resume, retry, stall detection, progress, and integrity verification.
 */
async function downloadResumable(url, destPath, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const { signal = null, allowPrivate = false, onProgress = null, sha256 = "", extraHeaders = {} } = opts;
    const partPath = `${destPath}.part`;
    const startedAt = Date.now();
    const state = { family: undefined, validator: "", totalBytes: 0, samples: [], lastEmitAt: 0, attempt: 0 };

    if (signal?.aborted) throw new DownloadError("Download aborted by user", { aborted: true });
    await assertSafePublicUrl(url, allowPrivate);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const emit = (info, force = false) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - state.lastEmitAt < 100) return;
        state.lastEmitAt = now;
        onProgress({
            maxAttempts: opts.maxAttempts,
            attempt: Math.max(1, state.attempt),
            totalBytes: state.totalBytes,
            elapsedMs: now - startedAt,
            ...info,
        });
    };

    const speedOf = (bytes, sessionStartBytes, sessionStartAt) => {
        const now = Date.now();
        state.samples.push({ t: now, b: bytes });
        while (state.samples.length > 2 && now - state.samples[0].t > 4000) state.samples.shift();
        const first = state.samples[0];
        const dt = (now - first.t) / 1000;
        if (dt >= 0.4) return Math.max(0, (bytes - first.b) / dt);
        const sdt = Math.max(0.05, (now - sessionStartAt) / 1000);
        return Math.max(0, (bytes - sessionStartBytes) / sdt);
    };

    const runAttempt = async () => {
        let existing = statSize(partPath);
        const ctl = new AbortController();
        const onParent = () => ctl.abort(new DownloadError("Download aborted by user", { aborted: true }));
        if (signal?.aborted) onParent();
        else signal?.addEventListener("abort", onParent, { once: true });
        let idleTimer = null;
        let file = null;
        const clearIdle = () => idleTimer && clearTimeout(idleTimer);

        try {
            emit({ status: "connecting", bytes: existing }, true);
            const headers = {
                ...BROWSER_HEADERS,
                Accept: "*/*",
                "Accept-Encoding": "identity",
                ...extraHeaders,
            };
            if (existing > 0) {
                headers.Range = `bytes=${existing}-`;
                if (state.validator) headers["If-Range"] = state.validator;
            }

            const { res } = await openResponse(url, {
                headers,
                family: state.family,
                connectTimeoutMs: opts.connectTimeoutMs,
                signal: ctl.signal,
                allowPrivate,
                maxRedirects: opts.maxRedirects,
            });

            const status = res.statusCode;
            if (status === 416) {
                res.resume();
                const m = /bytes \*\/(\d+)/.exec(String(res.headers["content-range"] || ""));
                const total = m ? Number(m[1]) : 0;
                if (existing > 0 && total && existing === total) {
                    state.totalBytes = total;
                    return { complete: true, size: existing, resumed: true };
                }
                throw new DownloadError("Partial file no longer matches server, restarting", { retryable: true, resetPart: true });
            }
            if (status < 200 || status >= 300) {
                res.resume();
                const retryAfter = Number(res.headers["retry-after"]);
                const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
                throw new DownloadError(`HTTP ${status} ${res.statusMessage || ""}`.trim(), {
                    retryable,
                    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60 ? retryAfter * 1000 : 0,
                });
            }

            let resuming = false;
            let total = 0;
            if (status === 206) {
                const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(String(res.headers["content-range"] || ""));
                if (!m || Number(m[1]) !== existing) {
                    res.resume();
                    throw new DownloadError("Server returned unexpected byte range, restarting", { retryable: true, resetPart: true });
                }
                resuming = true;
                total = m[3] === "*" ? 0 : Number(m[3]);
            } else {
                // 200: server ignored Range (or fresh download) -> start from zero
                existing = 0;
                total = Number(res.headers["content-length"]) || 0;
            }
            state.totalBytes = total || state.totalBytes;
            state.validator = String(res.headers.etag || res.headers["last-modified"] || state.validator || "");
            if (opts.maxBytes && total > opts.maxBytes) {
                res.resume();
                throw new DownloadError(`File is larger than the ${Math.round(opts.maxBytes / 1048576)} MB download limit`, { retryable: false });
            }
            checkDiskSpace(path.dirname(destPath), total ? total - existing : 0);

            file = fs.createWriteStream(partPath, { flags: resuming ? "a" : "w" });
            let bytes = existing;
            const sessionStartBytes = existing;
            const sessionStartAt = Date.now();
            state.samples = [{ t: sessionStartAt, b: bytes }];
            const resumedFrom = resuming ? existing : 0;

            const progressInfo = () => {
                const bytesPerSec = Math.round(speedOf(bytes, sessionStartBytes, sessionStartAt));
                const remaining = total > 0 ? Math.max(0, total - bytes) : 0;
                return {
                    status: "downloading",
                    bytes,
                    percent: total > 0 ? Math.min(100, (bytes / total) * 100) : null,
                    bytesPerSec,
                    etaSec: total > 0 && bytesPerSec > 0 ? remaining / bytesPerSec : null,
                    resumedFrom,
                };
            };

            await new Promise((resolve, reject) => {
                let settled = false;
                const fail = (err) => {
                    if (settled) return;
                    settled = true;
                    res.destroy();
                    reject(err);
                };
                const armIdle = () => {
                    clearIdle();
                    idleTimer = setTimeout(() => {
                        ctl.abort(
                            new DownloadError(`Stalled: no data received for ${Math.round(opts.idleTimeoutMs / 1000)}s`, {
                                retryable: true,
                                code: "ETIMEDOUT",
                            })
                        );
                    }, opts.idleTimeoutMs);
                };
                ctl.signal.addEventListener("abort", () => fail(ctl.signal.reason), { once: true });
                if (ctl.signal.aborted) return fail(ctl.signal.reason);

                armIdle();
                res.on("data", (chunk) => {
                    bytes += chunk.length;
                    armIdle();
                    if (opts.maxBytes && bytes > opts.maxBytes) {
                        ctl.abort(new DownloadError("Download exceeded the maximum allowed size", { retryable: false }));
                        return;
                    }
                    emit(progressInfo(), false);
                });
                res.on("error", (err) => fail(ctl.signal.aborted ? ctl.signal.reason : wrapNetworkError(err)));
                res.on("close", () => {
                    if (!res.complete) {
                        fail(
                            ctl.signal.aborted
                                ? ctl.signal.reason
                                : new DownloadError("Connection closed before download completed", { retryable: true })
                        );
                    }
                });
                file.on("error", (err) => fail(new DownloadError(`Disk write failed: ${err.message}`, { retryable: false })));
                file.on("finish", () => {
                    if (settled || !res.complete) return;
                    settled = true;
                    resolve();
                });
                res.pipe(file);
            });

            clearIdle();
            await closeFile(file);
            const size = statSize(partPath);
            if (total > 0 && size !== total) {
                throw new DownloadError(`Size mismatch: got ${size} of ${total} bytes`, { retryable: true, resetPart: size > total });
            }
            emit({ ...progressInfo(), bytes: size, percent: 100 }, true);
            return { complete: true, size, resumed: resumedFrom > 0 };
        } finally {
            clearIdle();
            signal?.removeEventListener("abort", onParent);
            await closeFile(file);
        }
    };

    let noProgressFailures = 0;
    let totalTries = 0;
    let everResumed = false;
    let result = null;

    while (true) {
        totalTries += 1;
        state.attempt = totalTries;
        const sizeBefore = statSize(partPath);
        try {
            result = await runAttempt();
            break;
        } catch (err) {
            if (signal?.aborted || err?.aborted) {
                const saved = statSize(partPath);
                throw new DownloadError(
                    `Download cancelled${saved ? ` (${Math.round(saved / 1024)} KB kept in ${path.basename(partPath)}; run again to resume)` : ""}`,
                    { aborted: true }
                );
            }
            const saved = statSize(partPath);
            if (err.resetPart) fs.rmSync(partPath, { force: true });
            const progressed = saved > sizeBefore;
            noProgressFailures = progressed ? 0 : noProgressFailures + 1;

            if (!isRetryable(err) || noProgressFailures >= opts.maxAttempts || totalTries >= opts.maxAttempts * 6) {
                const keep = statSize(partPath);
                const hint = keep > 0 ? ` Partial data (${(keep / 1048576).toFixed(2)} MB) kept at ${partPath}; call download_file again to resume.` : "";
                throw new DownloadError(`Download failed after ${totalTries} attempt(s): ${err.message}.${hint}`, {
                    retryable: false,
                    code: err.code,
                });
            }
            if (err.phase === "connect" && state.family === undefined) state.family = 4;
            if (saved > 0) everResumed = true;

            const backoff = Math.min(15000, opts.retryBaseDelayMs * 2 ** Math.min(noProgressFailures, 4));
            const delay = (err.retryAfterMs || backoff) + Math.floor(Math.random() * Math.min(250, opts.retryBaseDelayMs));
            emit(
                {
                    status: "retrying",
                    bytes: statSize(partPath),
                    note: `${err.message} - retry in ${Math.ceil(delay / 1000)}s (${noProgressFailures}/${opts.maxAttempts})`,
                    bytesPerSec: 0,
                },
                true
            );
            await sleepAbortable(delay, signal);
        }
    }

    if (sha256) {
        const actual = await hashFile(partPath);
        if (actual.toLowerCase() !== String(sha256).trim().toLowerCase()) {
            fs.rmSync(partPath, { force: true });
            throw new DownloadError(`SHA-256 mismatch: expected ${sha256}, got ${actual}. Corrupt file removed.`, { retryable: false });
        }
    }
    moveFile(partPath, destPath);

    return {
        bytes: result.size,
        totalBytes: state.totalBytes || result.size,
        elapsedMs: Date.now() - startedAt,
        attempts: totalTries,
        resumed: everResumed || result.resumed,
        verified: Boolean(sha256),
    };
}

module.exports = {
    DownloadError,
    DEFAULTS,
    downloadResumable,
    streamDownloadSafe: downloadResumable,
};
