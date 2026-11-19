"use strict";

const MODEL_PROFILES = [
    { match: /claude-(?:3-7|sonnet-4|opus-4|haiku-4|3-5)/i, contextWindow: 200000, supportsTemperature: true, supportsTools: true, inputPer1M: 3.0, outputPer1M: 15.0 },
    { match: /claude-3/i, contextWindow: 200000, supportsTemperature: true, supportsTools: true, inputPer1M: 3.0, outputPer1M: 15.0 },
    { match: /\b(?:o1|o3|o4)(?:-|$)/i, contextWindow: 200000, supportsTemperature: false, supportsTools: true, inputPer1M: 2.0, outputPer1M: 8.0 },
    { match: /gpt-4\.1/i, contextWindow: 1000000, supportsTemperature: true, supportsTools: true, inputPer1M: 2.0, outputPer1M: 8.0 },
    { match: /gpt-4o-mini/i, contextWindow: 128000, supportsTemperature: true, supportsTools: true, inputPer1M: 0.15, outputPer1M: 0.6 },
    { match: /gpt-4o/i, contextWindow: 128000, supportsTemperature: true, supportsTools: true, inputPer1M: 2.5, outputPer1M: 10.0 },
    { match: /gemini-(?:2|2\.5|3|4)/i, contextWindow: 1000000, supportsTemperature: true, supportsTools: true, inputPer1M: 1.25, outputPer1M: 5.0 },
    { match: /gemma-/i, contextWindow: 128000, supportsTemperature: true, supportsTools: true, inputPer1M: 0.1, outputPer1M: 0.2 },
    { match: /deepseek-r1|deepseek-reasoner/i, contextWindow: 128000, supportsTemperature: false, supportsTools: true, inputPer1M: 0.55, outputPer1M: 2.19 },
    { match: /deepseek/i, contextWindow: 128000, supportsTemperature: true, supportsTools: true, inputPer1M: 0.27, outputPer1M: 1.1 },
    { match: /qwen|llama-3/i, contextWindow: 128000, supportsTemperature: true, supportsTools: true, inputPer1M: 0.2, outputPer1M: 0.6 },
];

function lookupModelCapabilities(modelId = "") {
    const clean = String(modelId || "").trim();
    for (const p of MODEL_PROFILES) {
        if (p.match.test(clean)) return { ...p };
    }
    return {
        contextWindow: 128000,
        supportsTemperature: true,
        supportsTools: true,
        inputPer1M: 0,
        outputPer1M: 0,
    };
}

function estimateTokenCostUsd(modelId, promptTokens = 0, completionTokens = 0) {
    const prof = lookupModelCapabilities(modelId);
    const inCost = (Math.max(0, Number(promptTokens) || 0) / 1_000_000) * (prof.inputPer1M || 0);
    const outCost = (Math.max(0, Number(completionTokens) || 0) / 1_000_000) * (prof.outputPer1M || 0);
    return {
        totalUsd: inCost + outCost,
        inCost,
        outCost,
        knownPricing: Boolean(prof.inputPer1M || prof.outputPer1M),
    };
}

module.exports = {
    lookupModelCapabilities,
    estimateTokenCostUsd,
};
