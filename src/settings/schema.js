"use strict";

const AGENT_MODES = ["default", "accept-edits", "plan", "auto"];
const TOOL_PERMISSIONS = ["ask", "allow-reads", "allow-edits", "always-proceed"];
const NON_WORKSPACE_MODES = ["ask", "allow", "deny"];
const VERBOSITY_LEVELS = ["low", "normal", "high"];
const LANGUAGES = ["banglish", "bangla", "english"];
const RENDERING_MODES = ["fullscreen", "inline"];
const QUEUED_MESSAGE_MODES = ["queue", "interrupt"];
const COLOR_SCHEMES = ["amber", "dark", "light", "terminal"];

const DEFAULT_SYSTEM_PROMPT = [
    "You are Kovence CLI, an advanced multi-step CLI agent harness built by Kovence (https://kovence.com).",
    "Use tools proactively to inspect files, search code, edit cleanly, run tests/commands, download files/installers with download_file and install them with run_command, search online with web_search/google_search, fetch pages with web_fetch, and track multi-step plans with todo_write.",
    "When answering with online search results, synthesize the retrieved context cleanly and cite relevant sources.",
    "MEMORY RULE: Save persistent user preferences ONLY when explicitly requested via save_global_memory. Save temporary current-task notes using save_session_memory.",
].join("\n");

const DEFAULT_SETTINGS = {
    agentMode: "default",
    toolPermission: "ask",
    nonWorkspaceAccess: "ask",
    model: "",
    provider: "",
    toolsEnabled: true,
    autoSummarize: true,
    maxToolSteps: 25,
    maxHistoryMessages: 24,
    contextWindow: 128000,
    temperature: null,
    maxTokens: null,
    verbosity: "normal",
    language: "banglish",
    renderingMode: "fullscreen",
    queuedMessages: "queue",
    showTips: true,
    showActiveTasks: true,
    notifications: true,
    colorScheme: "amber",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

/**
 * Schema metadata powering both /set CLI validation and the interactive /settings UI.
 */
const SETTINGS_SCHEMA = [
    {
        key: "agentMode",
        label: "Agent Mode",
        type: "enum",
        options: AGENT_MODES,
        description:
            "'default': ask on mutations, 'accept-edits': auto-approve file edits, 'plan': read-only plan before edits, 'auto': allow all except denylist.",
    },
    {
        key: "toolPermission",
        label: "Tool Permission",
        type: "enum",
        options: TOOL_PERMISSIONS,
        description:
            "'ask': confirm per policy, 'allow-reads': never ask on reads/fetches, 'allow-edits': auto-approve edits, 'always-proceed': allow safe tools.",
    },
    {
        key: "nonWorkspaceAccess",
        label: "Non-Workspace Access",
        type: "enum",
        options: NON_WORKSPACE_MODES,
        description:
            "Access to paths outside workspace root (+ --add-dir): 'ask': prompt, 'allow': permit, 'deny': block.",
    },
    {
        key: "model",
        label: "Model",
        type: "string",
        description:
            "Default saved model ID (precedence: CLI --model > session model > saved setting > provider default).",
    },
    {
        key: "provider",
        label: "Provider",
        type: "string",
        description: "Active configured API provider profile name (cycle or press Enter to edit/switch).",
    },
    {
        key: "toolsEnabled",
        label: "Tools Enabled",
        type: "boolean",
        description: "'on': agent can invoke filesystem, shell, search and memory tools; 'off': chat-only mode.",
    },
    {
        key: "autoSummarize",
        label: "Auto Summarize",
        type: "boolean",
        description: "'on': compact older turns in background when history grows large; 'off': manual /compact only.",
    },
    {
        key: "maxToolSteps",
        label: "Max Tool Steps",
        type: "integer",
        min: 1,
        max: 100,
        description: "Maximum consecutive tool-calling loop iterations per user turn (1-100).",
    },
    {
        key: "maxHistoryMessages",
        label: "Max History Messages",
        type: "integer",
        min: 2,
        max: 500,
        description: "Target turn-aware message budget retained verbatim before pruning/summarizing (2-500).",
    },
    {
        key: "contextWindow",
        label: "Context Window",
        type: "integer",
        min: 1024,
        max: 2000000,
        description: "Model context window size in tokens used for budget tracking and auto-compaction (>= 1024).",
    },
    {
        key: "temperature",
        label: "Temperature",
        type: "nullableFloat",
        min: 0,
        max: 2,
        description: "Sampling temperature (0.0-2.0) or 'null' to use the model provider's default.",
    },
    {
        key: "maxTokens",
        label: "Max Tokens",
        type: "nullableInteger",
        min: 1,
        max: 1000000,
        description: "Maximum completion tokens per request or 'null' for provider default.",
    },
    {
        key: "verbosity",
        label: "Verbosity",
        type: "enum",
        options: VERBOSITY_LEVELS,
        description:
            "'low': minimal tool/status logs, 'normal': standard output, 'high': detailed diagnostics & audit trail.",
    },
    {
        key: "language",
        label: "Language",
        type: "enum",
        options: LANGUAGES,
        description: "Preferred assistant response language hint: 'banglish' (Latin script), 'bangla', or 'english'.",
    },
    {
        key: "renderingMode",
        label: "Rendering Mode",
        type: "enum",
        options: RENDERING_MODES,
        description: "'fullscreen': alt-screen Kovence TUI; 'inline': plain scrollback REPL on next launch.",
    },
    {
        key: "queuedMessages",
        label: "Queued Messages",
        type: "enum",
        options: QUEUED_MESSAGE_MODES,
        description:
            "When sending a prompt mid-turn: 'queue' runs after active turn; 'interrupt' aborts current turn first.",
    },
    {
        key: "showTips",
        label: "Show Tips",
        type: "boolean",
        description: "'on': show helpful shortcut and slash-command tips in welcome/status area; 'off': hide tips.",
    },
    {
        key: "showActiveTasks",
        label: "Show Active Tasks",
        type: "boolean",
        description: "'on': display live todo/background task status in the TUI; 'off': hide task banner.",
    },
    {
        key: "notifications",
        label: "Notifications",
        type: "boolean",
        description: "'on': emit terminal bell/notice when long turns finish or approval is needed; 'off': silent.",
    },
    {
        key: "colorScheme",
        label: "Color Scheme",
        type: "enum",
        options: COLOR_SCHEMES,
        description: "UI palette: 'amber' (Kovence orange/amber), 'dark', 'light', or 'terminal' (minimal ANSI).",
    },
    {
        key: "systemPrompt",
        label: "Edit System Prompt",
        type: "multilineString",
        description: "Base system instructions injected at the start of every request (press Enter to edit).",
    },
    {
        key: "managePermissions",
        label: "Manage Permissions",
        type: "action",
        description: "Open saved global & project permission rules (list, search, and delete rules).",
    },
];

const SCHEMA_BY_KEY = new Map(SETTINGS_SCHEMA.map((item) => [item.key, item]));

const KEY_ALIASES = {
    mode: "agentMode",
    agent_mode: "agentMode",
    tool_permission: "toolPermission",
    non_workspace_access: "nonWorkspaceAccess",
    tools: "toolsEnabled",
    tools_enabled: "toolsEnabled",
    auto_summarize: "autoSummarize",
    max_steps: "maxToolSteps",
    max_tool_steps: "maxToolSteps",
    max_history: "maxHistoryMessages",
    max_history_messages: "maxHistoryMessages",
    context: "contextWindow",
    context_window: "contextWindow",
    temp: "temperature",
    max_tokens: "maxTokens",
    rendering: "renderingMode",
    rendering_mode: "renderingMode",
    queued_messages: "queuedMessages",
    show_tips: "showTips",
    show_active_tasks: "showActiveTasks",
    color_scheme: "colorScheme",
    system_prompt: "systemPrompt",
};

const PERSISTABLE_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

/**
 * Resolve a user-facing key or alias to a canonical setting key.
 */
function canonicalSettingKey(rawKey) {
    const clean = String(rawKey || "").trim();
    if (SCHEMA_BY_KEY.has(clean)) return clean;
    const lower = clean.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    for (const key of PERSISTABLE_KEYS) {
        if (key.toLowerCase() === lower) return key;
    }
    return null;
}

/**
 * Parse and strictly validate a raw input value for a setting key.
 */
function parseSettingValue(rawKey, rawValue) {
    const key = canonicalSettingKey(rawKey);
    if (!key) {
        return { ok: false, error: `Unknown setting '${rawKey}'.` };
    }
    const meta = SCHEMA_BY_KEY.get(key);
    if (!meta || meta.type === "action") {
        return { ok: false, error: `'${key}' cannot be set directly.` };
    }

    if (typeof rawValue === "boolean" && meta.type === "boolean") {
        return { ok: true, key, value: rawValue };
    }

    const str = String(rawValue ?? "").trim();

    if (meta.type === "boolean") {
        if (/^(true|on|1|yes)$/i.test(str)) return { ok: true, key, value: true };
        if (/^(false|off|0|no)$/i.test(str)) return { ok: true, key, value: false };
        return { ok: false, error: `${meta.label} expects on/off or true/false (got '${str}').` };
    }

    if (meta.type === "enum") {
        const match = meta.options.find((opt) => opt.toLowerCase() === str.toLowerCase());
        if (!match) {
            return {
                ok: false,
                error: `${meta.label} must be one of: ${meta.options.join(", ")}.`,
            };
        }
        return { ok: true, key, value: match };
    }

    if (meta.type === "integer" || meta.type === "nullableInteger") {
        if (meta.type === "nullableInteger" && (!str || /^(null|none|default|unset)$/i.test(str))) {
            return { ok: true, key, value: null };
        }
        if (!/^-?\d+$/.test(str)) {
            return { ok: false, error: `${meta.label} must be a whole number.` };
        }
        const n = Number.parseInt(str, 10);
        if (!Number.isSafeInteger(n) || Number.isNaN(n)) {
            return { ok: false, error: `${meta.label} is not a valid integer.` };
        }
        if (meta.min !== undefined && n < meta.min) {
            return { ok: false, error: `${meta.label} must be >= ${meta.min}.` };
        }
        if (meta.max !== undefined && n > meta.max) {
            return { ok: false, error: `${meta.label} must be <= ${meta.max}.` };
        }
        return { ok: true, key, value: n };
    }

    if (meta.type === "nullableFloat") {
        if (!str || /^(null|none|default|unset)$/i.test(str)) {
            return { ok: true, key, value: null };
        }
        const n = Number(str);
        if (!Number.isFinite(n) || Number.isNaN(n)) {
            return { ok: false, error: `${meta.label} must be a number or 'null'.` };
        }
        if (meta.min !== undefined && n < meta.min) {
            return { ok: false, error: `${meta.label} must be >= ${meta.min}.` };
        }
        if (meta.max !== undefined && n > meta.max) {
            return { ok: false, error: `${meta.label} must be <= ${meta.max}.` };
        }
        return { ok: true, key, value: n };
    }

    return { ok: true, key, value: typeof rawValue === "string" ? rawValue : str };
}

module.exports = {
    AGENT_MODES,
    TOOL_PERMISSIONS,
    NON_WORKSPACE_MODES,
    VERBOSITY_LEVELS,
    LANGUAGES,
    RENDERING_MODES,
    QUEUED_MESSAGE_MODES,
    COLOR_SCHEMES,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_SETTINGS,
    SETTINGS_SCHEMA,
    SCHEMA_BY_KEY,
    PERSISTABLE_KEYS,
    canonicalSettingKey,
    parseSettingValue,
};
