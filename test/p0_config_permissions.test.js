"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolvePaths, migrateLegacyAiHarness, ensureStorageDirs } = require("../src/config/paths");
const { parseSettingValue } = require("../src/settings/schema");
const {
    loadPersistedSettings,
    savePersistedSettings,
    updatePersistedSetting,
    resolveEffectiveSettings,
    resolveEffectiveModel,
} = require("../src/settings/store");
const {
    loadProviders,
    saveProviders,
    upsertProvider,
    addProviderModels,
    redactSecret,
} = require("../src/config/providers");
const {
    classifyMemoryIntent,
    addGlobalMemory,
    loadGlobalMemoryEntries,
    MAX_GLOBAL_ITEMS,
} = require("../src/config/memory");
const { addPermissionRule, removePermissionRuleByIndex } = require("../src/permissions/store");
const { evaluatePermission, buildSuggestedRules, isReadOnlyShellCommand } = require("../src/permissions/engine");

function makeTempEnv() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-test-"));
    const globalDir = path.join(tmp, "global-config");
    const projectRoot = path.join(tmp, "repo");
    fs.mkdirSync(path.join(projectRoot, ".git", "info"), { recursive: true });
    const paths = resolvePaths({
        cwd: projectRoot,
        projectRoot,
        globalDir,
        projectDir: path.join(projectRoot, ".kovence"),
    });
    return { tmp, globalDir, projectRoot, paths };
}

test("B3: migrates .ai_harness safely into global & per-project dirs and ignores .kovence in git info/exclude", (t) => {
    const { tmp, projectRoot, paths } = makeTempEnv();
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const legacyDir = path.join(projectRoot, ".ai_harness");
    fs.mkdirSync(path.join(legacyDir, "sessions"), { recursive: true });
    fs.writeFileSync(
        path.join(legacyDir, "settings.json"),
        JSON.stringify({ model: "gpt-legacy", autoApprove: true, maxToolSteps: 12 }),
        "utf8"
    );
    fs.writeFileSync(
        path.join(legacyDir, "global_memory.json"),
        JSON.stringify({ items: ["Always use tabs", "Always use tabs"] }),
        "utf8"
    );
    fs.writeFileSync(
        path.join(legacyDir, "providers.json"),
        JSON.stringify({
            active: "custom",
            providers: {
                default: { name: "default", baseUrl: "http://stale", apiKey: "leaked-env" },
                custom: { name: "custom", type: "openai", baseUrl: "http://custom", apiKey: "k-123" },
            },
        }),
        "utf8"
    );
    fs.writeFileSync(
        path.join(legacyDir, "sessions", "work.json"),
        JSON.stringify({ id: "work", history: [{ role: "user", content: "hello" }] }),
        "utf8"
    );

    const res = migrateLegacyAiHarness(paths);
    assert.equal(res.migrated, true);
    assert.equal(res.summary.sessionsCopied, 1);
    assert.ok(fs.existsSync(path.join(paths.sessionsDir, "work.json")));

    const settings = loadPersistedSettings(paths);
    assert.equal(settings.model, "gpt-legacy");
    assert.equal(settings.agentMode, "auto");
    assert.equal(Object.hasOwn(settings, "autoApprove"), false);

    const mem = loadGlobalMemoryEntries(paths);
    assert.equal(mem.length, 1);
    assert.equal(mem[0].text, "Always use tabs");
    assert.equal(mem[0].source, "migrated");

    const excludeText = fs.readFileSync(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
    assert.match(excludeText, /\.kovence\//);

    // Second run is a no-op
    const res2 = migrateLegacyAiHarness(paths);
    assert.equal(res2.migrated, false);
});

test("B2: env 'default' provider is never written to providers.json and custom keys use 0600 + apiKeyEnv", (t) => {
    const { tmp, paths } = makeTempEnv();
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const envFallback = { baseUrl: "http://env.local/v1", apiKey: "ENV_SECRET_KEY", defaultModel: "env-model" };
    process.env.KOVENCE_TEST_CUSTOM_KEY = "FROM_ENV_VAR";
    t.after(() => delete process.env.KOVENCE_TEST_CUSTOM_KEY);

    upsertProvider(
        envFallback,
        { name: "work", type: "anthropic", baseUrl: "https://api.example.com", apiKeyEnv: "KOVENCE_TEST_CUSTOM_KEY" },
        paths
    );

    const rawDisk = JSON.parse(fs.readFileSync(paths.providersFile, "utf8"));
    assert.equal(rawDisk.providers.default, undefined);
    assert.equal(rawDisk.providers.work.apiKey, undefined);
    assert.equal(rawDisk.providers.work.apiKeyEnv, "KOVENCE_TEST_CUSTOM_KEY");

    const mode = fs.statSync(paths.providersFile).mode & 0o777;
    assert.equal(mode, 0o600);

    const loaded = loadProviders({ ...envFallback, baseUrl: "http://updated-env.local/v1" }, paths);
    assert.equal(loaded.providers.default.baseUrl, "http://updated-env.local/v1");
    assert.equal(loaded.providers.work.apiKey, "FROM_ENV_VAR");
    assert.equal(redactSecret("sk-1234567890"), "sk-1...7890");

    saveProviders(loaded, paths);
    const rawAfterSave = JSON.parse(fs.readFileSync(paths.providersFile, "utf8"));
    assert.equal(rawAfterSave.providers.default, undefined);
    assert.equal(rawAfterSave.providers.work.apiKey, undefined);

    // Individual multi-model support + addProviderModels
    upsertProvider(
        envFallback,
        {
            name: "openrouter",
            type: "openai",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "or-key",
            models: ["openai/gpt-4o", "anthropic/claude-3.7-sonnet"],
        },
        paths
    );
    const updated = addProviderModels(
        envFallback,
        "openrouter",
        ["google/gemini-2.5-pro", "meta-llama/llama-3.3-70b", "deepseek/deepseek-r1", "openai/gpt-4o"],
        paths
    );
    assert.equal(updated.models.length, 5);
    assert.equal(updated.defaultModel, "openai/gpt-4o");
});

test("B4: memory classifier ignores casual always/never/sobsomoy sentences and requires explicit intent", (t) => {
    const { tmp, paths } = makeTempEnv();
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    assert.equal(classifyMemoryIntent("this function always returns null, fix it"), null);
    assert.equal(classifyMemoryIntent("eta sobsomoy crash kore keno?"), null);
    assert.equal(classifyMemoryIntent("never skip error handling?"), null);

    const explicit = classifyMemoryIntent("/remember Always reply in Banglish");
    assert.deepEqual(explicit, { scope: "global", fact: "Always reply in Banglish", explicitCommand: true });

    const localExplicit = classifyMemoryIntent("remember that for this session only focus on tests");
    assert.equal(localExplicit.scope, "session");

    assert.equal(addGlobalMemory("Use 2-space indentation", "user", paths), true);
    assert.equal(addGlobalMemory("use 2-space indentation", "user", paths), false); // dedupe
    for (let i = 0; i < MAX_GLOBAL_ITEMS + 5; i++) {
        addGlobalMemory(`Rule item number ${i}`, "user", paths);
    }
    assert.equal(loadGlobalMemoryEntries(paths).length, MAX_GLOBAL_ITEMS);
});

test("B6/B7/A1: settings validation rejects NaN/invalid values, maintains model precedence, and prevents runtime override leak", (t) => {
    const { tmp, paths } = makeTempEnv();
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    assert.equal(parseSettingValue("maxToolSteps", "abc").ok, false);
    assert.equal(parseSettingValue("maxToolSteps", "0").ok, false);
    assert.equal(parseSettingValue("temperature", "NaN").ok, false);
    assert.equal(parseSettingValue("temperature", "3.5").ok, false);
    assert.equal(parseSettingValue("agentMode", "invalid-mode").ok, false);
    assert.equal(parseSettingValue("maxTokens", "null").value, null);

    savePersistedSettings({ model: "saved-model", agentMode: "default" }, paths);
    const runtime = resolveEffectiveSettings(loadPersistedSettings(paths), { cliAuto: true });
    assert.equal(runtime.agentMode, "auto");

    // Updating another persisted setting must NOT leak runtime cliAuto into settings.json!
    updatePersistedSetting("verbosity", "high", paths);
    const reloadedPersisted = loadPersistedSettings(paths);
    assert.equal(reloadedPersisted.verbosity, "high");
    assert.equal(reloadedPersisted.agentMode, "default");

    assert.equal(
        resolveEffectiveModel({
            cliModel: "cli-m",
            sessionModel: "sess-m",
            persistedModel: "set-m",
            providerDefaultModel: "prov-m",
        }),
        "cli-m"
    );
    assert.equal(
        resolveEffectiveModel({
            cliModel: "",
            sessionModel: "sess-m",
            persistedModel: "set-m",
            providerDefaultModel: "prov-m",
        }),
        "sess-m"
    );
    assert.equal(
        resolveEffectiveModel({
            cliModel: "",
            sessionModel: "",
            persistedModel: "set-m",
            providerDefaultModel: "prov-m",
        }),
        "set-m"
    );
    assert.equal(
        resolveEffectiveModel({
            cliModel: "",
            sessionModel: "",
            persistedModel: "",
            providerDefaultModel: "prov-m",
        }),
        "prov-m"
    );
});

test("A2/A3: permission engine enforces plan mode, tokenized compound commands, hard denylist, sudo, and workspace boundaries", (t) => {
    const { tmp, projectRoot, paths } = makeTempEnv();
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    ensureStorageDirs(paths);

    // Plan mode blocks mutations and unsafe shell commands
    assert.equal(isReadOnlyShellCommand("ls -la | grep foo"), true);
    assert.equal(isReadOnlyShellCommand("git status && git diff --stat"), true);
    assert.equal(isReadOnlyShellCommand("ls -la && rm -rf /tmp/x"), false);
    assert.equal(isReadOnlyShellCommand("echo hi > out.txt"), false);
    assert.equal(isReadOnlyShellCommand("find . -delete"), false);

    const planWrite = evaluatePermission({
        toolName: "write_file",
        args: { path: "a.txt", content: "hi" },
        settings: { agentMode: "plan" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(planWrite.decision, "block");
    assert.match(planWrite.reason, /Plan mode/i);

    // Prefix rule must NOT allow unapproved chained segment
    addPermissionRule(
        { action: "allow", tool: "run_command", scope: "commandPrefix", pattern: "ls" },
        "project",
        paths
    );
    const singleLs = evaluatePermission({
        toolName: "run_command",
        args: { command: "ls -la" },
        settings: { agentMode: "default", toolPermission: "ask" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(singleLs.decision, "allow");

    const chainedLsRm = evaluatePermission({
        toolName: "run_command",
        args: { command: "ls -la && rm foo.txt" },
        settings: { agentMode: "default", toolPermission: "ask" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(chainedLsRm.decision, "ask");

    // Hard catastrophic denylist ALWAYS asks even in auto/always-proceed
    const hardRm = evaluatePermission({
        toolName: "run_command",
        args: { command: "rm -rf /" },
        settings: { agentMode: "auto", toolPermission: "always-proceed" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(hardRm.decision, "ask");
    assert.equal(hardRm.hardDenied, true);

    // Secret read asks in default mode, auto-allows in auto mode
    const secretReadDefault = evaluatePermission({
        toolName: "read_file",
        args: { path: ".env" },
        settings: { agentMode: "default", toolPermission: "ask" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(secretReadDefault.decision, "ask");
    assert.equal(secretReadDefault.hardDenied, true);

    // In auto mode, sudo and edits/downloads are auto-allowed (only 1-time session sudo password is prompted if needed)
    const sudoAuto = evaluatePermission({
        toolName: "run_command",
        args: { command: "sudo apt update" },
        settings: { agentMode: "auto", toolPermission: "ask" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(sudoAuto.decision, "allow");

    // In default and accept-edits modes, sudo asks confirmation
    const sudoDefault = evaluatePermission({
        toolName: "run_command",
        args: { command: "sudo apt update" },
        settings: { agentMode: "accept-edits", toolPermission: "ask" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(sudoDefault.decision, "ask");
    assert.equal(sudoDefault.requiresSudo, true);

    // In accept-edits mode: file edits & read-only commands auto-allow, mutating commands ask
    assert.equal(
        evaluatePermission({
            toolName: "edit_file",
            args: { path: "src/app.js", target: "a", replacement: "b" },
            settings: { agentMode: "accept-edits" },
            workspaceRoot: projectRoot,
            paths,
        }).decision,
        "allow"
    );
    assert.equal(
        evaluatePermission({
            toolName: "run_command",
            args: { command: "npm test" },
            settings: { agentMode: "accept-edits" },
            workspaceRoot: projectRoot,
            paths,
        }).decision,
        "ask"
    );

    // Non-workspace path boundary + symlink escape protection
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-outside-"));
    t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
    const linkPath = path.join(projectRoot, "escape-link");
    fs.symlinkSync(outsideDir, linkPath);

    const escaped = evaluatePermission({
        toolName: "read_file",
        args: { path: path.join("escape-link", "secret.txt") },
        settings: { agentMode: "auto", nonWorkspaceAccess: "deny" },
        workspaceRoot: projectRoot,
        paths,
    });
    assert.equal(escaped.decision, "block");

    // Suggested rule default for compound vs simple commands & removal
    const suggestions = buildSuggestedRules("run_command", { command: "npm test" }, projectRoot);
    assert.equal(suggestions[0].rule.pattern, "npm test");
    assert.ok(removePermissionRuleByIndex(1, paths));
});
