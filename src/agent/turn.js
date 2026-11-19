"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
    loadGlobalMemory,
    saveGlobalMemory,
    addGlobalMemory,
    classifyMemoryIntent,
    saveSession,
    renameSession,
    suggestSessionIdFromPrompt,
    evaluatePermission,
    buildSuggestedRules,
    addPermissionRule,
    loadProviders,
} = require("../../store");
const { TOOL_DEFINITIONS, executeTool, capOutput } = require("../../tools");
const { streamProviderTurn, completeProviderFast } = require("../../providers");
const { estimateMessagesTokens, sliceValidHistory } = require("./history");
const { gatherEnvironmentSummary, loadProjectInstructions } = require("./project_context");
const { repairToolArguments, LoopDetector } = require("./resilience");
const { summarizeArgsShort, getEnvFallback } = require("../commands/handlers");

function createAbortError(message = "Task cancelled by user") {
    const err = new Error(message);
    err.name = "AbortError";
    err.aborted = true;
    return err;
}

function expandFileMentions(text, workspaceRoot = process.cwd()) {
    const matches = [...String(text || "").matchAll(/(?:^|\s)@([^\s]+)/g)];
    if (!matches.length) return text;
    const attached = [];
    const seen = new Set();
    for (const m of matches) {
        const rawSpec = m[1].replace(/[.,;:!?]+$/, "");
        if (!rawSpec || seen.has(rawSpec)) continue;
        seen.add(rawSpec);
        let rel = rawSpec;
        let lineStart = null;
        let lineEnd = null;
        const rangeMatch = rawSpec.match(/^(.+?):L?(\d+)(?:-L?(\d+))?$/i);
        if (rangeMatch) {
            rel = rangeMatch[1];
            lineStart = Math.max(1, Number.parseInt(rangeMatch[2], 10));
            lineEnd = rangeMatch[3] ? Math.max(lineStart, Number.parseInt(rangeMatch[3], 10)) : lineStart;
        }
        const abs = path.resolve(workspaceRoot, rel);
        try {
            if (fs.statSync(abs).isFile()) {
                const rawText = fs.readFileSync(abs, "utf8");
                if (lineStart !== null) {
                    const lines = rawText.split(/\r?\n/);
                    const slice = lines
                        .slice(lineStart - 1, lineEnd)
                        .map((ln, idx) => `${lineStart + idx}: ${ln}`)
                        .join("\n");
                    attached.push(
                        `--- File: ${rel} (Lines ${lineStart}-${Math.min(lineEnd, lines.length)}) ---\n${capOutput(slice)}`
                    );
                } else {
                    attached.push(`--- File: ${rel} ---\n${capOutput(rawText)}`);
                }
            }
        } catch {}
    }
    return attached.length ? `${text}\n\n${attached.join("\n\n")}` : text;
}

function buildRequestMessages(state) {
    const root = state.workspaceRoot || process.cwd();
    const sysParts = [
        state.settings.systemPrompt,
        `Workspace Root: ${root}\nEnvironment: ${gatherEnvironmentSummary(root)}`,
    ];
    const projectDocs = loadProjectInstructions(root);
    if (projectDocs) sysParts.push(projectDocs);
    if (state.settings.language) {
        const langMap = {
            banglish: "Language Preference: Respond in Banglish (Bengali written cleanly in Latin/Roman alphabet).",
            bangla: "Language Preference: Respond in Bengali.",
            english: "Language Preference: Respond in clear English.",
        };
        if (langMap[state.settings.language]) sysParts.push(langMap[state.settings.language]);
    }
    if (state.settings.agentMode === "plan") {
        sysParts.push(
            [
                "AGENT MODE = PLAN (STRICT READ-ONLY RESEARCH):",
                "1. Investigate the codebase/task using read-only tools only. Do NOT modify files or run mutating commands.",
                "2. Output a clear, structured implementation plan containing: Goal, Files to Change, Steps, Risks, and How to Verify.",
                "3. Stop and ask the user to approve the plan before any edits.",
            ].join("\n")
        );
    }

    const msgs = [{ role: "system", content: sysParts.join("\n\n") }];

    const globalMem = loadGlobalMemory(state.paths);
    if (globalMem.length) {
        msgs.push({
            role: "system",
            content: `[Global Default Memory (shared)]\n${globalMem.map((x, i) => `${i + 1}. ${x}`).join("\n")}`,
        });
    }

    const sessionBlocks = [];
    if (state.session.summaryMemory) {
        sessionBlocks.push(`[Session '${state.session.id}' Memory Summary]\n${state.session.summaryMemory}`);
    }
    if (state.session.pinnedMemory.length) {
        sessionBlocks.push(
            `[Session '${state.session.id}' Pinned Local Facts]\n${state.session.pinnedMemory.map((x) => `- ${x}`).join("\n")}`
        );
    }
    if (state.session.todos.length) {
        const todoLines = state.session.todos.map((t, i) => `${i + 1}. [${t.status}] ${t.task}`).join("\n");
        sessionBlocks.push(`[Session '${state.session.id}' Multi-Step Todos]\n${todoLines}`);
    }
    if (sessionBlocks.length) {
        msgs.push({ role: "system", content: sessionBlocks.join("\n\n") });
    }

    const win = Number(state.settings.contextWindow) || 128000;
    const overhead = estimateMessagesTokens(msgs);
    const histBudget = Math.max(2048, Math.floor(win * 0.78) - overhead);
    const recent = sliceValidHistory(state.session.history, state.settings.maxHistoryMessages, histBudget);
    return [...msgs, ...recent];
}

function formatEditDiffPreview(target = "", replacement = "") {
    const tLines = String(target)
        .split("\n")
        .slice(0, 6)
        .map((l) => `  - ${l}`);
    const rLines = String(replacement)
        .split("\n")
        .slice(0, 6)
        .map((l) => `  + ${l}`);
    const moreT = String(target).split("\n").length > 6 ? ["  - ..."] : [];
    const moreR = String(replacement).split("\n").length > 6 ? ["  + ..."] : [];
    return [...tLines, ...moreT, ...rLines, ...moreR].join("\n");
}

/**
 * Render detailed, non-truncated permission preview with risk label, full command, edit diff, or write preview (A3).
 */
function formatApprovalPreview(toolName, rawArgs, evalResult) {
    let args = {};
    try {
        args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs || {};
    } catch {}

    const risk = evalResult?.risk || "MEDIUM";
    const lines = [`[Permission Required · Risk: ${risk}] Tool: ${toolName}`];
    if (evalResult?.reason) lines.push(`Reason: ${evalResult.reason}`);

    if (toolName === "run_command") {
        lines.push(`Command:\n  ${String(args.command || "")}`);
    } else if (toolName === "write_file") {
        const content = String(args.content || "");
        const preview = content.split("\n").slice(0, 8).join("\n");
        lines.push(`File: ${args.path} (${Buffer.byteLength(content, "utf8")} bytes)`);
        lines.push(`Preview:\n${preview.slice(0, 500)}${content.length > 500 ? "\n  ..." : ""}`);
    } else if (toolName === "edit_file") {
        lines.push(`File: ${args.path}`);
        lines.push(`Diff:\n${formatEditDiffPreview(args.target, args.replacement)}`);
    } else if (toolName === "multi_edit") {
        lines.push(`File: ${args.path} (${Array.isArray(args.edits) ? args.edits.length : 0} edits)`);
        if (Array.isArray(args.edits) && args.edits[0]) {
            lines.push(`First edit diff:\n${formatEditDiffPreview(args.edits[0].target, args.edits[0].replacement)}`);
        }
    } else if (toolName === "delete_file") {
        lines.push(`Delete file: ${args.path}`);
    } else if (toolName === "download_file" || toolName === "web_fetch") {
        lines.push(`URL: ${args.url}`);
    } else {
        lines.push(`Args: ${JSON.stringify(args)}`);
    }
    return lines.join("\n");
}

function getProviderSecretEnvKeys(state) {
    try {
        const store = loadProviders(getEnvFallback(), state.paths);
        return Object.values(store.providers || {})
            .map((p) => p.apiKeyEnv)
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function waitForMemorySync(state) {
    if (state.memorySyncPromise) {
        try {
            await state.memorySyncPromise;
        } catch {}
    }
}

async function updateSessionMemory(state, userText, assistantText, toolsUsed, sink, options = {}) {
    if (!state.settings.autoSummarize && !options.force) return;
    if (state.headless || state.noSession) return;

    const prev = state.session.summaryMemory || "(none)";
    const toolNote = toolsUsed.length ? `\nTools used: ${toolsUsed.join(", ")}` : "";
    const digestPrompt = [
        {
            role: "system",
            content:
                "Maintain a concise rolling memory summary for THIS session only (max 180 words). Merge the previous summary with the new exchange, keeping goals, decisions, file paths, facts, and outcomes. Output ONLY the updated summary.",
        },
        {
            role: "user",
            content: `Previous summary:\n${prev}\n\nNew User message:\n${userText.slice(0, 1500)}${toolNote}\n\nAssistant response:\n${assistantText.slice(0, 2000)}`,
        },
    ];

    const abortCtrl = new AbortController();
    state.memoryAbort = abortCtrl;

    const job = (async () => {
        try {
            const summary = await completeProviderFast({
                provider: state.provider,
                model: state.model,
                messages: digestPrompt,
                maxTokens: 300,
                temperature: 0.2,
                signal: abortCtrl.signal,
                capabilities: state.capabilities,
                toolDefinitions: TOOL_DEFINITIONS,
                timeoutMs: 25000,
            });
            if (abortCtrl.signal.aborted) return;
            if (summary) {
                state.session.summaryMemory = summary;
                saveSession(state.session, state.paths);
                sink.syncStatus();
                sink.log("meta", `🧠 Session '${state.session.id}' memory updated`);
                return;
            }
        } catch (err) {
            if (abortCtrl.signal.aborted || err?.name === "AbortError") return;
        }

        const snippet = `- User: ${userText.replace(/\s+/g, " ").slice(0, 120)} -> AI: ${assistantText.replace(/\s+/g, " ").slice(0, 160)}`;
        const merged = state.session.summaryMemory ? `${state.session.summaryMemory}\n${snippet}` : snippet;
        state.session.summaryMemory = merged.slice(-2000);
        saveSession(state.session, state.paths);
        sink.syncStatus();
        if (options.verbose !== false) {
            sink.log("meta", `🧠 Session '${state.session.id}' memory saved (local fallback)`);
        }
    })().finally(() => {
        if (state.memorySyncPromise === job) state.memorySyncPromise = null;
        if (state.memoryAbort === abortCtrl) state.memoryAbort = null;
    });

    state.memorySyncPromise = job;
    if (options.blocking) await job;
}

async function runToolCalls(state, toolCalls, sink) {
    const results = new Array(toolCalls.length);
    const parallelBatch = [];
    const workspaceRoot = state.workspaceRoot || process.cwd();
    const extraSecretEnvKeys = getProviderSecretEnvKeys(state);

    const isAutoMode = () => state.settings.agentMode === "auto" || state.settings.toolPermission === "always-proceed";

    const makeCtx = (approvedByUser = false, skipDownloadDestPrompt = false, onToolOutput = null) => ({
        cwd: workspaceRoot,
        workspaceRoot,
        paths: state.paths,
        extraDirs: state.extraDirs || [],
        extraSecretEnvKeys,
        settings: state.settings,
        session: state.session,
        autoApprove: isAutoMode(),
        approvedByUser: approvedByUser || isAutoMode(),
        skipDownloadDestPrompt: skipDownloadDestPrompt || isAutoMode(),
        onToolOutput,
        openChoicePicker: sink.openChoicePicker,
        bgTasks: state.bgTasks || null,
        _permissionChecked: true,
        signal: state.activeAbort?.signal || null,
        saveSession: (s) => {
            if (!state.noSession) saveSession(s, state.paths);
        },
        loadGlobalMemory: () => loadGlobalMemory(state.paths),
        saveGlobalMemory: (items) => saveGlobalMemory(items, state.paths),
        addGlobalMemory: (fact, src) => addGlobalMemory(fact, src, state.paths),
        getSudoPassword: () => state.sudoPasswords.get(state.session.id) || "",
        setSudoPassword: (pw) => {
            if (pw) state.sudoPasswords.set(state.session.id, pw);
            else state.sudoPasswords.delete(state.session.id);
        },
        askPrompt: sink.askPrompt,
        askPassword: sink.askPassword,
        startProgress: sink.startProgress,
        setBusy: sink.setBusy,
        log: sink.log,
    });

    let downloadFailedOrCancelled = false;

    const flushParallel = async () => {
        if (!parallelBatch.length) return;
        const batch = parallelBatch.splice(0, parallelBatch.length);
        await Promise.all(batch);
    };

    for (let i = 0; i < toolCalls.length; i++) {
        if (state.activeAbort?.signal?.aborted) {
            await flushParallel();
            throw createAbortError();
        }
        const tc = toolCalls[i];
        const name = tc.function.name;
        const summary = summarizeArgsShort(tc.function.arguments);

        // If an earlier download in the same turn was cancelled or failed, never execute follow-up commands on missing files.
        if (downloadFailedOrCancelled && name === "run_command") {
            const msg = "Skipped command because the preceding download did not complete.";
            results[i] = { role: "tool", tool_call_id: tc.id, name, content: msg };
            sink.log("tool", `⏸ ${name}(${summary}) skipped (download incomplete)`);
            continue;
        }
        let parsedArgs = {};
        try {
            parsedArgs =
                typeof tc.function.arguments === "string"
                    ? repairToolArguments(tc.function.arguments || "{}")
                    : tc.function.arguments || {};
        } catch {}

        const evalRes = evaluatePermission({
            toolName: name,
            args: parsedArgs,
            settings: state.settings,
            workspaceRoot,
            extraDirs: state.extraDirs || [],
            sessionRules: state.sessionRules,
            paths: state.paths,
        });

        if (evalRes.decision === "block") {
            results[i] = {
                role: "tool",
                tool_call_id: tc.id,
                name,
                content: evalRes.reason,
            };
            sink.log("tool", `⛔ ${name}(${summary}) blocked: ${evalRes.reason}`);
            continue;
        }

        let approvedByUser = false;
        let skipDownloadDestPrompt = Boolean(evalRes.matchedRule);

        if (evalRes.decision === "ask") {
            if (!sink.interactive || !sink.confirm) {
                results[i] = {
                    role: "tool",
                    tool_call_id: tc.id,
                    name,
                    content: `Denied: '${name}' requires interactive approval (${evalRes.reason}).`,
                };
                sink.log("tool", `✗ ${name}(${summary}) requires approval`);
                continue;
            }

            const preview = formatApprovalPreview(name, parsedArgs, evalRes);
            sink.log("permission", preview);
            sink.notify?.();
            const rawChoice = (await sink.confirm(`Allow ${name}? [y=once / n=deny / s=session / A=always]: `)).trim();
            if (state.activeAbort?.signal?.aborted) {
                throw createAbortError();
            }
            const lowerChoice = rawChoice.toLowerCase();

            if (lowerChoice === "y" || lowerChoice === "yes") {
                approvedByUser = true;
            } else if ((lowerChoice === "s" || rawChoice === "A") && !evalRes.hardDenied && !evalRes.requiresSudo) {
                approvedByUser = true;
                const suggestions = buildSuggestedRules(name, parsedArgs, workspaceRoot);
                const defRule = suggestions[0];
                const altHint = suggestions.length > 1 ? ` or type 'tool' for all ${name}` : "";
                const scopeAns = (
                    await sink.confirm(
                        `Save ${lowerChoice === "s" ? "session" : "always (project)"} allow rule for ${defRule.label}${altHint}? [Enter=yes / n=once only]: `
                    )
                )
                    .trim()
                    .toLowerCase();

                if (scopeAns !== "n" && scopeAns !== "no") {
                    const picked =
                        scopeAns === "tool" && suggestions[suggestions.length - 1]
                            ? suggestions[suggestions.length - 1].rule
                            : defRule.rule;
                    if (lowerChoice === "s") {
                        state.sessionRules.push(picked);
                        sink.log(
                            "meta",
                            `✓ session rule added: ${picked.tool} (${picked.scope}: ${picked.pattern || "*"})`
                        );
                    } else {
                        addPermissionRule(picked, "project", state.paths);
                        sink.log(
                            "meta",
                            `✓ project rule saved: ${picked.tool} (${picked.scope}: ${picked.pattern || "*"})`
                        );
                    }
                    skipDownloadDestPrompt = true;
                }
            } else if ((lowerChoice === "s" || rawChoice === "A") && (evalRes.hardDenied || evalRes.requiresSudo)) {
                approvedByUser = true;
                sink.log(
                    "meta",
                    "Note: hard-denylist/sudo commands are allowed once (cannot be permanently auto-allowed)."
                );
            } else {
                results[i] = { role: "tool", tool_call_id: tc.id, name, content: "Denied by user." };
                sink.log("tool", `✗ ${name}(${summary}) denied`);
                continue;
            }
        } else if (evalRes.matchedRule && evalRes.ruleLabel) {
            sink.log("meta", `✓ auto-allowed by rule: ${evalRes.ruleLabel}`);
        }

        const isSequential =
            evalRes.decision === "ask" ||
            name === "run_command" ||
            name === "download_file" ||
            name === "write_file" ||
            name === "edit_file" ||
            name === "multi_edit" ||
            name === "delete_file";

        const runOne = async () => {
            const toolUi =
                name !== "download_file" && sink.startToolCall
                    ? sink.startToolCall(`⚙ ${name}(${summary})`, { collapsible: true })
                    : null;
            if (!toolUi && name !== "download_file") {
                sink.log("tool", `⚙ ${name}(${summary})`);
            }
            if (name === "download_file") {
                state.isDownloading = true;
                sink.setBusy("Downloading (commands paused)...");
            } else if (name === "write_file" || name === "edit_file" || name === "multi_edit") {
                const target = parsedArgs.path ? parsedArgs.path.split("/").pop() : "";
                sink.setBusy(`Writing ${target || "file"}...`);
                // Populate write stats for the live TUI write indicator.
                if (toolUi && toolUi.startWrite) {
                    const writeContent =
                        typeof parsedArgs.content === "string"
                            ? parsedArgs.content
                            : typeof parsedArgs.replacement === "string"
                              ? parsedArgs.replacement
                              : "";
                    toolUi.startWrite({ filePath: parsedArgs.path || "", content: writeContent });
                }
            } else if (name === "read_file" || name === "glob_files" || name === "grep_files") {
                const target = parsedArgs.path ? parsedArgs.path.split("/").pop() : "";
                sink.setBusy(`Reading ${target || "code"}...`);
            } else {
                sink.setBusy(`Running ${name}...`);
            }
            try {
                const out = await executeTool(
                    name,
                    parsedArgs,
                    makeCtx(approvedByUser, skipDownloadDestPrompt, (chunk) => toolUi?.pushOutput(chunk))
                );
                const outStr = String(out);
                results[i] = { role: "tool", tool_call_id: tc.id, name, content: outStr };
                toolUi?.finish(outStr, /^Exit |^Command timed out/i.test(outStr));
                if (name === "download_file" && /^Download cancelled/i.test(outStr)) {
                    downloadFailedOrCancelled = true;
                }
            } catch (err) {
                if (state.activeAbort?.signal?.aborted || err?.aborted || err?.name === "AbortError") {
                    toolUi?.finish("Aborted by user", true);
                    throw createAbortError(err?.message || "Task cancelled by user");
                }
                if (name === "download_file") downloadFailedOrCancelled = true;
                results[i] = { role: "tool", tool_call_id: tc.id, name, content: `Error: ${err.message}` };
                toolUi?.finish(`Error: ${err.message}`, true);
                sink.log("error", `✗ ${name}: ${err.message}`);
            } finally {
                if (name === "download_file") {
                    state.isDownloading = false;
                    sink.syncStatus();
                }
            }
        };

        if (isSequential) {
            // Ensure no background parallel tool writes to screen while sequential download/command executes.
            await flushParallel();
            await runOne();
        } else {
            parallelBatch.push(runOne());
        }
    }

    await flushParallel();
    return results;
}

function repairTranscriptTail(history, dropTrailingUser = false) {
    // Keep completed steps intact; trim trailing unfulfilled tool_calls or orphan tool messages so /retry & resume work cleanly.
    while (history.length > 0) {
        const last = history[history.length - 1];
        if (last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
            history.pop();
            continue;
        }
        break;
    }
    if (dropTrailingUser && history.length > 0 && history[history.length - 1].role === "user") {
        history.pop();
    }
}

async function runAgentTurn(state, userText, sink, options = {}) {
    state.lastFailedPrompt = "";
    const workspaceRoot = state.workspaceRoot || process.cwd();

    // B4: Explicit memory intent ONLY, with user confirmation
    if (!options.isRetry) {
        const memIntent = classifyMemoryIntent(userText);
        if (memIntent) {
            const autoMode = state.settings.agentMode === "auto" || state.settings.toolPermission === "always-proceed";
            let allowSave = true;
            if (!memIntent.explicitCommand && !autoMode && sink.interactive && sink.confirm) {
                const ans = (await sink.confirm(`Save to ${memIntent.scope} memory: "${memIntent.fact}"? [y/n]: `))
                    .trim()
                    .toLowerCase();
                allowSave = ans === "y" || ans === "yes";
            }
            if (allowSave) {
                if (memIntent.scope === "global" && addGlobalMemory(memIntent.fact, "user", state.paths)) {
                    sink.log("meta", `🌐 Saved to Global Shared Memory`);
                } else if (memIntent.scope === "session" && !state.session.pinnedMemory.includes(memIntent.fact)) {
                    state.session.pinnedMemory.push(memIntent.fact);
                    if (!state.noSession) saveSession(state.session, state.paths);
                    sink.log("meta", `📌 Saved to Session '${state.session.id}' local memory`);
                }
            }
        }
    }

    const expanded = expandFileMentions(userText, workspaceRoot);
    if (!state.session.title && !options.isRetry) {
        const cleanTitle = String(userText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60);
        if (cleanTitle) {
            state.session.title = cleanTitle;
            // Match any auto-generated session ID pattern:
            //   compact:  session-20261119-102809-6a3
            //   iso-like: session-2026-11-19-10-28-09-6a3
            const isAutoId = /^session-[\d][\d-]{6,}-[a-z0-9]{2,8}$/i.test(state.session.id);
            if (isAutoId && state.paths) {
                const nextId = suggestSessionIdFromPrompt(userText, state.paths);
                if (state.noSession) {
                    state.session.id = nextId;
                } else {
                    renameSession(state.session, nextId, state.paths);
                }
                sink.syncStatus();
            }
        }
    }
    if (state.debug) {
        sink.log(
            "meta",
            `[debug] turn start · model=${state.model} · mode=${state.settings.agentMode} · history=${state.session.history.length}`
        );
    }
    state.session.history.push({ role: "user", content: expanded });
    const toolsUsed = [];
    let finalAssistantText = "";
    let lastUsage = null;
    let totalTurnMs = 0;
    let emptyRetried = false;

    // Keep one AbortController alive across BOTH LLM streaming and all tool executions (download_file, run_command, etc.)
    const turnAbort = new AbortController();
    state.activeAbort = turnAbort;

    try {
        const maxSteps = Math.max(1, Number(state.settings.maxToolSteps) || 25);
        const loopDetector = new LoopDetector(3);
        for (let step = 0; step < maxSteps; step++) {
            if (turnAbort.signal.aborted) throw createAbortError();
            sink.setBusy(step ? `Step ${step + 1}...` : "Thinking...");
            const reqMessages = buildRequestMessages(state);
            const ctxEst = estimateMessagesTokens(reqMessages);
            const ctxWin = state.settings.contextWindow || 128000;
            if (state.settings.verbosity === "high" && step > 0) {
                sink.log("meta", `[verbose] Step ${step + 1}/${maxSteps} · ~${ctxEst} tokens`);
            }

            const turn = await streamProviderTurn({
                provider: state.provider,
                model: state.model,
                settings: state.settings,
                messages: reqMessages,
                signal: turnAbort.signal,
                sink,
                capabilities: state.capabilities,
                toolDefinitions: TOOL_DEFINITIONS,
            });
            if (turnAbort.signal.aborted) throw createAbortError();

            totalTurnMs += turn.elapsedMs;
            lastUsage = turn.usage;
            state.session.stats.requests += 1;
            state.session.stats.totalMs += turn.elapsedMs;
            state.session.stats.lastTtftMs = turn.ttftMs;
            state.session.stats.lastTokPerSec = turn.tokPerSec;
            if (turn.usage) {
                state.session.stats.promptTokens += turn.usage.prompt_tokens || 0;
                state.session.stats.completionTokens += turn.usage.completion_tokens || 0;
            }

            // B14: Guard against empty silent assistant response
            if (!turn.toolCalls.length && !turn.content) {
                if (!emptyRetried) {
                    emptyRetried = true;
                    state.session.history.push({
                        role: "user",
                        content:
                            "You returned an empty response. Provide a helpful final answer or call an appropriate tool.",
                    });
                    continue;
                }
                throw new Error("Model returned an empty response.");
            }

            const assistantMsg = { role: "assistant", content: turn.content || "" };
            if (turn.toolCalls.length) assistantMsg.tool_calls = turn.toolCalls;
            state.session.history.push(assistantMsg);

            if (!turn.toolCalls.length) {
                finalAssistantText = turn.content;
                const sec = (turn.elapsedMs / 1000).toFixed(2);
                const ttftStr = turn.ttftMs >= 1000 ? `${(turn.ttftMs / 1000).toFixed(2)}s` : `${turn.ttftMs}ms`;
                const speedStr = turn.tokPerSec ? ` · ${turn.tokPerSec} tok/s` : "";
                const ctxStr = ` · Context: ~${turn.usage?.prompt_tokens || ctxEst} / ${ctxWin}`;
                const usageStr = turn.usage
                    ? ` · Tokens: ${turn.usage.prompt_tokens ?? 0} in, ${turn.usage.completion_tokens ?? 0} out`
                    : ` · Output: ~${turn.outTokens} tok`;
                if (state.settings.verbosity !== "low") {
                    sink.log("meta", `Response: ${sec}s · TTFT: ${ttftStr}${speedStr}${ctxStr}${usageStr}`);
                }
                if (turn.elapsedMs >= 5000) sink.notify?.();

                // A2: Structured Plan Approval Workflow when finishing in 'plan' mode
                if (state.settings.agentMode === "plan" && sink.interactive && sink.confirm) {
                    const ans = (
                        await sink.confirm(
                            "Approve plan? [1=accept-edits / 2=auto / 3=default / 4=keep planning / 5=cancel]: "
                        )
                    )
                        .trim()
                        .toLowerCase();
                    if (ans === "1" || ans === "accept-edits" || ans === "y") {
                        state.settings.agentMode = "accept-edits";
                        state.session.agentMode = "accept-edits";
                        sink.syncStatus();
                        sink.log("meta", "✓ Plan approved — switched to 'accept-edits' mode. Continuing...");
                        state.session.history.push({
                            role: "user",
                            content:
                                "Plan approved. Switched to accept-edits mode. Proceed with implementing the plan now.",
                        });
                        continue;
                    }
                    if (ans === "2" || ans === "auto") {
                        state.settings.agentMode = "auto";
                        state.session.agentMode = "auto";
                        sink.syncStatus();
                        sink.log("meta", "✓ Plan approved — switched to 'auto' mode. Continuing...");
                        state.session.history.push({
                            role: "user",
                            content: "Plan approved. Switched to auto mode. Proceed with implementing the plan now.",
                        });
                        continue;
                    }
                    if (ans === "3" || ans === "default") {
                        state.settings.agentMode = "default";
                        state.session.agentMode = "default";
                        sink.syncStatus();
                        sink.log("meta", "✓ Plan approved — switched to 'default' mode. Continuing...");
                        state.session.history.push({
                            role: "user",
                            content: "Plan approved. Switched to default mode. Proceed step-by-step now.",
                        });
                        continue;
                    }
                    if (ans === "4") {
                        sink.log("meta", "Staying in 'plan' mode. Ask follow-up refinements in your next message.");
                    }
                }

                if (!state.noSession) saveSession(state.session, state.paths);
                sink.syncStatus();
                // B20: Trigger non-blocking background session memory update
                void updateSessionMemory(state, userText, turn.content, toolsUsed, sink, {
                    blocking: false,
                    verbose: state.settings.verbosity === "high",
                });
                return {
                    ok: true,
                    answer: finalAssistantText,
                    toolsUsed,
                    usage: lastUsage,
                    elapsedMs: totalTurnMs,
                };
            }

            for (const tc of turn.toolCalls) toolsUsed.push(tc.function.name);
            const loopCheck = loopDetector.record(turn.toolCalls);
            if (loopCheck.repeated) {
                sink.log(
                    "system",
                    `⚠ Detected repeated identical tool calls (${loopCheck.count}x). Asking model to try a different approach or summarize.`
                );
                state.session.history.push({
                    role: "user",
                    content:
                        "You have repeated the exact same tool call multiple times without making progress. Do NOT repeat it again — either try a different approach/arguments or explain the blocker to the user.",
                });
                if (!state.noSession) saveSession(state.session, state.paths);
                continue;
            }
            sink.setBusy("Running tools...");
            const toolResults = await runToolCalls(state, turn.toolCalls, sink);
            if (turnAbort.signal.aborted) throw createAbortError();
            state.session.history.push(...toolResults);
            if (!state.noSession) saveSession(state.session, state.paths);
            sink.syncStatus();
        }

        sink.log("system", `Reached maxToolSteps (${state.settings.maxToolSteps}).`);
        if (!state.noSession) saveSession(state.session, state.paths);
        return { ok: true, answer: finalAssistantText, toolsUsed, usage: lastUsage, elapsedMs: totalTurnMs };
    } catch (err) {
        const isAbort = Boolean(turnAbort.signal.aborted || err?.name === "AbortError" || err?.aborted);
        // When user cancels, drop unanswered trailing user turn because the prompt is restored directly into the input box
        repairTranscriptTail(state.session.history, isAbort);
        state.lastFailedPrompt = userText;
        if (!state.noSession) saveSession(state.session, state.paths);
        sink.syncStatus();
        if (isAbort && err?.name !== "AbortError") {
            throw createAbortError(err?.message || "Task cancelled by user");
        }
        throw err;
    } finally {
        if (state.activeAbort === turnAbort) state.activeAbort = null;
    }
}

async function compactSession(state, sink) {
    if (state.session.history.length <= 2) {
        sink.log("system", "Session history already compact.");
        return;
    }
    const lastUserIdx = state.session.history.findLastIndex((m) => m.role === "user");
    const keepFrom = lastUserIdx > 0 ? lastUserIdx : state.session.history.length;
    const toSummarize = state.session.history.slice(0, keepFrom);
    const tail = state.session.history.slice(keepFrom);
    const textDump = toSummarize.map((m) => `${m.role}: ${m.content || JSON.stringify(m.tool_calls || "")}`).join("\n");
    await updateSessionMemory(state, textDump.slice(0, 3000), "(manual compaction)", [], sink, {
        force: true,
        blocking: true,
        verbose: true,
    });
    state.session.history = tail;
    if (!state.noSession) saveSession(state.session, state.paths);
    sink.syncStatus();
    sink.log("system", `Compacted ${toSummarize.length} messages into session memory summary.`);
}

module.exports = {
    expandFileMentions,
    buildRequestMessages,
    formatApprovalPreview,
    waitForMemorySync,
    updateSessionMemory,
    runToolCalls,
    runAgentTurn,
    compactSession,
};
