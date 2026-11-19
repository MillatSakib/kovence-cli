"use strict";

const { lookupModelCapabilities } = require("./src/config/model_registry");

function buildProviderUrls(provider) {
    const base = String(provider?.baseUrl || "").replace(/\/+$/, "");
    if (!base) throw new Error("Provider baseUrl is not configured.");
    if (provider.type === "anthropic") {
        if (base.endsWith("/messages")) {
            return { chatUrl: base, modelsUrl: base.replace(/\/messages$/, "/models") };
        }
        const v1 = base.endsWith("/v1") ? base : `${base}/v1`;
        return { chatUrl: `${v1}/messages`, modelsUrl: `${v1}/models` };
    }
    if (base.endsWith("/chat/completions")) {
        return { chatUrl: base, modelsUrl: base.replace(/\/chat\/completions$/, "/models") };
    }
    const v1 = base.endsWith("/v1") ? base : `${base}/v1`;
    return { chatUrl: `${v1}/chat/completions`, modelsUrl: `${v1}/models` };
}

function buildProviderHeaders(provider) {
    if (provider.type === "anthropic") {
        const h = {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
        };
        if (provider.apiKey) h["x-api-key"] = provider.apiKey;
        return h;
    }
    const h = { "Content-Type": "application/json" };
    if (provider.apiKey) h.Authorization = `Bearer ${provider.apiKey}`;
    return h;
}

/**
 * Convert OpenAI-style messages into Anthropic Messages API shape while guaranteeing valid user-first turns.
 */
function toAnthropicMessages(messages) {
    const systemParts = [];
    const out = [];
    let pendingToolResults = [];

    const flushTools = () => {
        if (!pendingToolResults.length) return;
        out.push({ role: "user", content: pendingToolResults });
        pendingToolResults = [];
    };

    for (const m of messages) {
        if (m.role === "system") {
            if (m.content) systemParts.push(m.content);
            continue;
        }
        if (m.role === "tool") {
            pendingToolResults.push({
                type: "tool_result",
                tool_use_id: m.tool_call_id || "tool_0",
                content: String(m.content || ""),
            });
            continue;
        }
        flushTools();
        if (m.role === "assistant") {
            const blocks = [];
            if (m.content) blocks.push({ type: "text", text: String(m.content) });
            if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    let inputObj = {};
                    try {
                        inputObj = JSON.parse(tc.function?.arguments || "{}");
                    } catch {}
                    blocks.push({
                        type: "tool_use",
                        id: tc.id || `tool_${blocks.length}`,
                        name: tc.function?.name || "unknown",
                        input: inputObj,
                    });
                }
            }
            if (blocks.length) out.push({ role: "assistant", content: blocks });
            continue;
        }
        const prev = out[out.length - 1];
        if (prev && prev.role === "user" && typeof prev.content === "string") {
            prev.content = `${prev.content}\n\n${String(m.content || "")}`.trim();
        } else {
            out.push({ role: "user", content: String(m.content || "") });
        }
    }
    flushTools();

    // Anthropic API requires the first non-system message to have role 'user'.
    while (out.length > 0 && out[0].role !== "user") {
        out.shift();
    }
    if (out.length === 0) {
        out.push({ role: "user", content: "Continue." });
    }
    return { system: systemParts.join("\n\n"), messages: out };
}

function toAnthropicTools(toolDefinitions) {
    return toolDefinitions.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

/**
 * Per-(provider, model) capability cache so an error on one model never disables tools globally.
 */
function getModelCapabilities(capabilitiesStore, provider, model) {
    if (!capabilitiesStore) {
        return { supportsStreamOptions: true, supportsTools: true };
    }
    if (typeof capabilitiesStore.supportsStreamOptions === "boolean" && !capabilitiesStore._byModel) {
        // Legacy flat capability object compatibility
        return capabilitiesStore;
    }
    if (!capabilitiesStore._byModel) capabilitiesStore._byModel = new Map();
    const key = `${provider?.name || "default"}::${model || provider?.defaultModel || "default"}`;
    if (!capabilitiesStore._byModel.has(key)) {
        capabilitiesStore._byModel.set(key, { supportsStreamOptions: true, supportsTools: true });
    }
    return capabilitiesStore._byModel.get(key);
}

function isRetryableStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504 || status === 529;
}

function isTransientNetworkError(err) {
    if (!err) return false;
    const msg = `${err.name || ""} ${err.code || ""} ${err.message || ""}`;
    return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|fetch failed|network/i.test(msg);
}

function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason || new Error("Aborted"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason || new Error("Aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function createLinkedController(parentSignal, timeoutMs) {
    const controller = new AbortController();
    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    }
    const onParentAbort = () => controller.abort(parentSignal.reason || new Error("Aborted"));
    if (parentSignal) {
        if (parentSignal.aborted) {
            controller.abort(parentSignal.reason || new Error("Aborted"));
        } else {
            parentSignal.addEventListener("abort", onParentAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            if (timer) clearTimeout(timer);
            parentSignal?.removeEventListener("abort", onParentAbort);
        },
    };
}

async function listProviderModels(provider, { timeoutMs = 15000, signal = null } = {}) {
    const { modelsUrl } = buildProviderUrls(provider);
    const linked = createLinkedController(signal, timeoutMs);
    try {
        const res = await fetch(modelsUrl, { headers: buildProviderHeaders(provider), signal: linked.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return (data.data || []).map((m) => m.id).filter(Boolean);
    } finally {
        linked.cleanup();
    }
}

const STREAM_OPTIONS_UNSUPPORTED_RE =
    /\b(stream_options|include_usage)\b.*(unsupported|unknown|unrecognized|not allowed|invalid|not supported)/i;
const TOOLS_UNSUPPORTED_RE =
    /(does not support|not support|unsupported|unavailable for|cannot use).{0,40}\b(tools?|function[ _]call|tool_choice)\b|\b(tools?|tool_choice)\b.{0,40}(is|are) not supported/i;

async function fetchWithAdapter({
    provider,
    model,
    settings,
    bodyBase,
    signal,
    capabilities,
    toolDefinitions,
    timeoutMs = 120000,
    maxRetries = 3,
}) {
    const { chatUrl } = buildProviderUrls(provider);
    const headers = buildProviderHeaders(provider);
    const isAnthropic = provider.type === "anthropic";
    const modelCaps = getModelCapabilities(capabilities, provider, model);
    const registryCaps = lookupModelCapabilities(model);

    let lastRes = null;
    let downgradeAttempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) throw signal.reason || new Error("Aborted");

        let payload;
        if (isAnthropic) {
            const conv = toAnthropicMessages(bodyBase.messages);
            payload = {
                model,
                messages: conv.messages,
                max_tokens: bodyBase.max_tokens || settings?.maxTokens || 4096,
                stream: Boolean(bodyBase.stream),
            };
            if (conv.system) payload.system = conv.system;
            if (!bodyBase._noTools && settings?.toolsEnabled && modelCaps.supportsTools) {
                payload.tools = toAnthropicTools(toolDefinitions);
            }
            if (
                registryCaps.supportsTemperature !== false &&
                Number.isFinite(bodyBase.temperature ?? settings?.temperature)
            ) {
                payload.temperature = bodyBase.temperature ?? settings.temperature;
            }
        } else {
            payload = {
                model,
                messages: bodyBase.messages,
                stream: Boolean(bodyBase.stream),
            };
            if (payload.stream && modelCaps.supportsStreamOptions) {
                payload.stream_options = { include_usage: true };
            }
            if (
                !bodyBase._noTools &&
                settings?.toolsEnabled &&
                modelCaps.supportsTools &&
                registryCaps.supportsTools !== false
            ) {
                payload.tools = toolDefinitions;
                payload.tool_choice = "auto";
            }
            if (
                registryCaps.supportsTemperature !== false &&
                Number.isFinite(bodyBase.temperature ?? settings?.temperature)
            ) {
                payload.temperature = bodyBase.temperature ?? settings.temperature;
            }
            if (Number.isFinite(bodyBase.max_tokens ?? settings?.maxTokens)) {
                payload.max_tokens = bodyBase.max_tokens ?? settings.maxTokens;
            }
        }

        const linked = createLinkedController(signal, timeoutMs);
        let res;
        try {
            res = await fetch(chatUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal: linked.signal,
            });
        } catch (err) {
            linked.cleanup();
            if (signal?.aborted) throw err;
            if (attempt < maxRetries && (isTransientNetworkError(err) || /timed out/i.test(err.message))) {
                const backoff = Math.min(8000, 600 * 2 ** attempt) + Math.floor(Math.random() * 250);
                await sleepAbortable(backoff, signal);
                continue;
            }
            throw err;
        }
        linked.cleanup();

        if (res.ok) return res;
        lastRes = res;

        // Transient HTTP errors: retry with Retry-After or jittered exponential backoff
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
            await res.text().catch(() => "");
            const retryAfterRaw = Number(res.headers.get("retry-after"));
            const backoff =
                Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 && retryAfterRaw <= 30
                    ? retryAfterRaw * 1000
                    : Math.min(10000, 800 * 2 ** attempt) + Math.floor(Math.random() * 300);
            await sleepAbortable(backoff, signal);
            continue;
        }

        if (res.status !== 400 && res.status !== 422) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }

        const errText = await res.text();
        let downgraded = false;
        if (downgradeAttempts < 2) {
            if (!isAnthropic && modelCaps.supportsStreamOptions && STREAM_OPTIONS_UNSUPPORTED_RE.test(errText)) {
                modelCaps.supportsStreamOptions = false;
                downgraded = true;
            }
            if (modelCaps.supportsTools && TOOLS_UNSUPPORTED_RE.test(errText)) {
                modelCaps.supportsTools = false;
                downgraded = true;
            }
        }
        if (!downgraded) throw new Error(`HTTP ${res.status}: ${errText}`);
        downgradeAttempts += 1;
    }

    throw new Error(
        `HTTP ${lastRes?.status || "error"}: ${lastRes ? await lastRes.text().catch(() => "") : "Exhausted retries"}`
    );
}

async function streamProviderTurn({
    provider,
    model,
    settings,
    messages,
    signal,
    sink,
    capabilities,
    toolDefinitions,
    timeoutMs = 120000,
}) {
    const startedAt = Date.now();
    const streamUi = sink.startThinking("Kovence: ", "Thinking");
    let res;
    try {
        res = await fetchWithAdapter({
            provider,
            model,
            settings,
            bodyBase: { messages, stream: true },
            signal,
            capabilities,
            toolDefinitions,
            timeoutMs,
        });
        if (!res.body) throw new Error("Empty response body from API");
    } catch (err) {
        streamUi.stop(false);
        throw err;
    }

    let firstTokenAt = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let printedHeader = false;
    let usage = null;
    let finishReason = null;
    const toolMap = new Map();
    const isAnthropic = provider.type === "anthropic";

    const markFirstToken = (forText) => {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        if (!printedHeader) {
            streamUi.stop(forText);
            printedHeader = true;
        }
    };

    const mergeOpenAITools = (deltas) => {
        for (const d of deltas) {
            const idx = d.index ?? 0;
            if (!toolMap.has(idx)) {
                toolMap.set(idx, {
                    id: d.id || `call_${idx}`,
                    type: "function",
                    function: { name: "", arguments: "" },
                });
            }
            const entry = toolMap.get(idx);
            if (d.id) entry.id = d.id;
            if (d.function?.name) entry.function.name += d.function.name;
            if (d.function?.arguments) entry.function.arguments += d.function.arguments;
        }
    };

    const handleLine = (rawLine) => {
        const line = rawLine.replace(/\r$/, "");
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let json;
        try {
            json = JSON.parse(data);
        } catch {
            return;
        }
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

        if (isAnthropic) {
            if (json.type === "message_start" && json.message?.usage) {
                usage = {
                    prompt_tokens: json.message.usage.input_tokens || 0,
                    completion_tokens: json.message.usage.output_tokens || 0,
                };
            } else if (json.type === "message_delta") {
                if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
                if (json.usage) {
                    usage = {
                        prompt_tokens: usage?.prompt_tokens || 0,
                        completion_tokens: json.usage.output_tokens ?? usage?.completion_tokens ?? 0,
                    };
                }
            } else if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
                markFirstToken(false);
                const idx = json.index ?? toolMap.size;
                toolMap.set(idx, {
                    id: json.content_block.id || `call_${idx}`,
                    type: "function",
                    function: { name: json.content_block.name || "", arguments: "" },
                });
            } else if (json.type === "content_block_delta") {
                if (json.delta?.type === "text_delta" && json.delta.text) {
                    markFirstToken(true);
                    streamUi.write(json.delta.text);
                    fullText += json.delta.text;
                } else if (json.delta?.type === "input_json_delta" && json.delta.partial_json) {
                    markFirstToken(false);
                    const idx = json.index ?? 0;
                    const entry = toolMap.get(idx);
                    if (entry) entry.function.arguments += json.delta.partial_json;
                }
            }
            return;
        }

        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (delta?.tool_calls?.length) {
            markFirstToken(false);
            mergeOpenAITools(delta.tool_calls);
        }
        const token = delta?.content ?? json.response ?? "";
        if (token) {
            markFirstToken(true);
            streamUi.write(token);
            fullText += token;
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) handleLine(line);
        }
        if (buffer) handleLine(buffer);
    } finally {
        if (!printedHeader) streamUi.stop(false);
    }

    streamUi.end(Boolean(fullText));
    const finishedAt = Date.now();
    const elapsedMs = finishedAt - startedAt;
    const ttftMs = firstTokenAt !== null ? firstTokenAt - startedAt : elapsedMs;
    const outTokens = usage?.completion_tokens ?? (fullText ? Math.max(1, Math.ceil(fullText.length / 4)) : 0);
    const genSec = Math.max(0.001, (finishedAt - (firstTokenAt || startedAt)) / 1000);
    const tokPerSec = outTokens ? Number((outTokens / genSec).toFixed(1)) : 0;

    const toolCalls = [...toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    return { content: fullText, toolCalls, usage, finishReason, elapsedMs, ttftMs, tokPerSec, outTokens };
}

async function completeProviderFast({
    provider,
    model,
    messages,
    maxTokens = 300,
    temperature = 0.2,
    signal = null,
    capabilities,
    toolDefinitions = [],
    timeoutMs = 30000,
}) {
    const res = await fetchWithAdapter({
        provider,
        model,
        settings: null,
        bodyBase: { messages, stream: false, max_tokens: maxTokens, temperature, _noTools: true },
        signal,
        capabilities,
        toolDefinitions,
        timeoutMs,
        maxRetries: 1,
    });
    const data = await res.json();
    if (provider.type === "anthropic") {
        const texts = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
        return texts.join("").trim();
    }
    return data.choices?.[0]?.message?.content?.trim() || "";
}

module.exports = {
    buildProviderUrls,
    buildProviderHeaders,
    toAnthropicMessages,
    getModelCapabilities,
    isRetryableStatus,
    listProviderModels,
    fetchWithAdapter,
    streamProviderTurn,
    completeProviderFast,
};
