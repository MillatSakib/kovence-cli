"use strict";

const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const zlib = require("node:zlib");

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const BROWSER_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Linux"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    DNT: "1",
};

/**
 * Determine whether an IPv4 or IPv6 address belongs to loopback, link-local, or private network space.
 */
function isPrivateOrLocalIp(ip) {
    const clean = String(ip || "")
        .trim()
        .replace(/^\[|\]$/g, "")
        .split("%")[0]
        .toLowerCase();
    if (!clean) return true;
    if (clean.startsWith("::ffff:")) return isPrivateOrLocalIp(clean.slice(7));

    if (net.isIPv4(clean)) {
        const parts = clean.split(".").map(Number);
        const [a, b] = parts;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        if (a === 169 && b === 254) return true; // Link-local / cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a >= 224) return true;
        return false;
    }

    if (net.isIPv6(clean)) {
        if (clean === "::1" || clean === "::" || clean === "0:0:0:0:0:0:0:1") return true;
        if (clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) return true;
        return false;
    }
    return true;
}

/**
 * Verify URL uses http/https without embedded credentials and does not resolve to private/loopback/metadata IPs.
 */
async function assertSafePublicUrl(rawUrl, allowPrivate = false) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || ""));
    } catch {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Blocked unsupported URL protocol '${parsed.protocol}'. Only http/https allowed.`);
    }
    if (parsed.username || parsed.password) {
        throw new Error("URLs with embedded credentials are not allowed.");
    }
    if (allowPrivate) return parsed;

    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        throw new Error(`SSRF blocked: private/local hostname '${host}'`);
    }
    if (net.isIP(host)) {
        if (isPrivateOrLocalIp(host)) throw new Error(`SSRF blocked: private/loopback IP '${host}'`);
        return parsed;
    }

    const addrs = await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`DNS resolution failed for '${host}'`);
    for (const entry of addrs) {
        if (isPrivateOrLocalIp(entry.address)) {
            throw new Error(`SSRF blocked: '${host}' resolved to private/local IP '${entry.address}'`);
        }
    }
    return parsed;
}

function decodeHtmlEntities(str = "") {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&nbsp;/g, " ");
}

/**
 * Lightweight zero-dep HTML to Markdown converter for readable fetched web pages.
 */
function htmlToMarkdown(html = "") {
    let out = String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "");

    out = out
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
        .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n")
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
        .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
        .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
        .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|section|article|tr)>/gi, "\n\n")
        .replace(/<[^>]+>/g, " ");

    out = decodeHtmlEntities(out)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return out;
}

/**
 * Fetch remote URL safely with SSRF checks, redirect verification, size cap, and AbortSignal.
 */
async function safeHttpGet(targetUrl, options = {}, redirectsLeft = 5) {
    const {
        extraHeaders = {},
        timeout = 15000,
        signal = null,
        maxBytes = MAX_RESPONSE_BYTES,
        allowPrivate = false,
    } = options;

    if (signal?.aborted) throw new Error("Request aborted");
    const parsed = await assertSafePublicUrl(targetUrl, allowPrivate);

    return new Promise((resolve, reject) => {
        const client = parsed.protocol === "https:" ? https : http;
        const req = client.request(
            parsed,
            { method: "GET", headers: { ...BROWSER_HEADERS, ...extraHeaders }, timeout },
            (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    const nextUrl = new URL(res.headers.location, targetUrl).toString();
                    safeHttpGet(
                        nextUrl,
                        { ...options, extraHeaders: { ...extraHeaders, Referer: targetUrl } },
                        redirectsLeft - 1
                    ).then(resolve, reject);
                    return;
                }

                const enc = (res.headers["content-encoding"] || "").toLowerCase();
                let stream = res;
                if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
                else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
                else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

                const chunks = [];
                let total = 0;
                let truncated = false;

                stream.on("data", (chunk) => {
                    if (total + chunk.length > maxBytes) {
                        const remain = Math.max(0, maxBytes - total);
                        if (remain > 0) chunks.push(chunk.subarray(0, remain));
                        truncated = true;
                        stream.destroy();
                        res.destroy();
                        return;
                    }
                    total += chunk.length;
                    chunks.push(chunk);
                });
                stream.on("end", () => {
                    resolve({
                        status: res.statusCode || 0,
                        url: targetUrl,
                        headers: res.headers,
                        truncated,
                        text: Buffer.concat(chunks).toString("utf8"),
                    });
                });
                stream.on("close", () => {
                    if (truncated) {
                        resolve({
                            status: res.statusCode || 0,
                            url: targetUrl,
                            headers: res.headers,
                            truncated: true,
                            text: Buffer.concat(chunks).toString("utf8"),
                        });
                    }
                });
                stream.on("error", (err) => {
                    if (!truncated) reject(err);
                });
            }
        );

        const onAbort = () => req.destroy(new Error("Request aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.on("error", (err) => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
        });
        req.on("close", () => signal?.removeEventListener("abort", onAbort));
        req.end();
    });
}

async function safeHttpPostJson(targetUrl, bodyObj, options = {}) {
    const { headers = {}, timeout = 15000, signal = null, allowPrivate = false } = options;
    if (signal?.aborted) throw new Error("Request aborted");
    await assertSafePublicUrl(targetUrl, allowPrivate);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeout);
    const onParentAbort = () => controller.abort(signal.reason || new Error("Aborted"));
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
        const res = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(bodyObj),
            signal: controller.signal,
        });
        const text = await res.text();
        return { status: res.status, text };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onParentAbort);
    }
}

/**
 * Format nested AggregateError or Node socket errors cleanly (never blank string).
 */
function formatNetworkError(err) {
    if (!err) return "Unknown network error";
    if (Array.isArray(err.errors) && err.errors.length > 0) {
        const inner = err.errors
            .map((e) => e?.message || e?.code || String(e))
            .filter(Boolean)
            .join("; ");
        if (inner) return inner;
    }
    return err.message || err.code || err.name || String(err);
}

function formatTransferSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format a uniform ASCII/Unicode progress bar with percentage and transfer speed.
 */
function formatEta(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(sec)) return "";
    const s = Math.max(0, Math.ceil(sec));
    if (s >= 3600) return ` · ETA ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return ` · ETA ${Math.floor(s / 60)}m${s % 60}s`;
    return ` · ETA ${s}s`;
}

function formatDownloadProgress({
    filename,
    bytes,
    totalBytes = 0,
    bytesPerSec = 0,
    etaSec = null,
    status = "downloading",
    note = "",
    attempt = 1,
    maxAttempts = 1,
    resumedFrom = 0,
}) {
    const barWidth = 20;
    if (status === "retrying") {
        return `⟳ ${filename} · ${note || "reconnecting"} · ${formatTransferSize(bytes)} saved (will resume)`;
    }
    if (status === "connecting") {
        const resumeNote = bytes > 0 ? ` · resuming from ${formatTransferSize(bytes)}` : "";
        const tryNote = attempt > 1 ? ` · try ${attempt}` : "";
        return `⬇ ${filename} · connecting...${resumeNote}${tryNote}`;
    }
    const speedText = `${formatTransferSize(bytesPerSec)}/s`;
    const extra = `${resumedFrom > 0 ? " · resumed" : ""}${attempt > 1 ? ` · try ${attempt}` : ""}`;
    if (totalBytes > 0) {
        const ratio = Math.max(0, Math.min(1, bytes / totalBytes));
        const filled = Math.round(ratio * barWidth);
        const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
        const pct = (ratio * 100).toFixed(1).padStart(5);
        return `⬇ ${filename} [${bar}] ${pct}% · ${formatTransferSize(bytes)} / ${formatTransferSize(totalBytes)} · ${speedText}${formatEta(etaSec)}${extra}`;
    }
    const pulse = Math.floor(Date.now() / 180) % barWidth;
    let bar = "";
    for (let i = 0; i < barWidth; i++) {
        bar += Math.abs(i - pulse) <= 1 ? "▓" : "░";
    }
    return `⬇ ${filename} [${bar}] ${formatTransferSize(bytes)} · ${speedText}${extra}`;
}

function unwrapDdgUrl(rawUrl) {
    try {
        const u = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl, "https://duckduckgo.com");
        if (u.pathname === "/l/" && u.searchParams.has("uddg")) return u.searchParams.get("uddg");
        return u.toString();
    } catch {
        return rawUrl;
    }
}

/**
 * Pluggable web search: Tavily -> Brave -> SearXNG -> Google CSE -> DuckDuckGo HTML fallback.
 */
async function runPluggableSearch(query, limit = 5, signal = null) {
    if (process.env.TAVILY_API_KEY) {
        const res = await safeHttpPostJson(
            "https://api.tavily.com/search",
            { api_key: process.env.TAVILY_API_KEY, query, max_results: limit },
            { signal }
        );
        if (res.status >= 200 && res.status < 300) {
            const data = JSON.parse(res.text);
            return {
                backend: "tavily",
                results: (data.results || []).slice(0, limit).map((r) => ({
                    title: r.title || "",
                    url: r.url || "",
                    snippet: r.content || "",
                })),
            };
        }
    }

    if (process.env.BRAVE_API_KEY) {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
        const res = await safeHttpGet(url, {
            extraHeaders: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY },
            signal,
        });
        if (res.status >= 200 && res.status < 300) {
            const data = JSON.parse(res.text);
            return {
                backend: "brave",
                results: (data.web?.results || []).slice(0, limit).map((r) => ({
                    title: r.title || "",
                    url: r.url || "",
                    snippet: r.description || "",
                })),
            };
        }
    }

    if (process.env.SEARXNG_URL) {
        const base = process.env.SEARXNG_URL.replace(/\/+$/, "");
        const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
        const res = await safeHttpGet(url, {
            extraHeaders: { Accept: "application/json" },
            signal,
            allowPrivate: true, // SearXNG is often self-hosted locally
        });
        if (res.status >= 200 && res.status < 300) {
            const data = JSON.parse(res.text);
            return {
                backend: "searxng",
                results: (data.results || []).slice(0, limit).map((r) => ({
                    title: r.title || "",
                    url: r.url || "",
                    snippet: r.content || "",
                })),
            };
        }
    }

    if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) {
        const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(
            process.env.GOOGLE_API_KEY
        )}&cx=${encodeURIComponent(process.env.GOOGLE_CSE_ID)}&num=${limit}&q=${encodeURIComponent(query)}`;
        const res = await safeHttpGet(url, { extraHeaders: { Accept: "application/json" }, signal });
        if (res.status >= 200 && res.status < 300) {
            const data = JSON.parse(res.text);
            return {
                backend: "google-cse",
                results: (data.items || []).map((it) => ({
                    title: it.title || "",
                    url: it.link || "",
                    snippet: it.snippet || "",
                })),
            };
        }
    }

    // Zero-config DuckDuckGo HTML fallback
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await safeHttpGet(ddgUrl, {
        extraHeaders: { Referer: "https://duckduckgo.com/" },
        signal,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Search HTTP ${res.status}`);
    const results = [];
    const blocks = res.text.split(/class="result__body"|class="links_main/i).slice(1);
    for (const block of blocks) {
        if (results.length >= limit) break;
        const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        const snipMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
        results.push({
            title: decodeHtmlEntities(
                linkMatch[2]
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
            ),
            url: unwrapDdgUrl(decodeHtmlEntities(linkMatch[1].replace(/<[^>]+>/g, "").trim())),
            snippet: snipMatch
                ? decodeHtmlEntities(
                      snipMatch[1]
                          .replace(/<[^>]+>/g, " ")
                          .replace(/\s+/g, " ")
                          .trim()
                  )
                : "",
        });
    }
    return { backend: "duckduckgo", results };
}

module.exports = {
    BROWSER_HEADERS,
    isPrivateOrLocalIp,
    assertSafePublicUrl,
    decodeHtmlEntities,
    htmlToMarkdown,
    safeHttpGet,
    formatNetworkError,
    formatTransferSize,
    formatDownloadProgress,
    runPluggableSearch,
};
