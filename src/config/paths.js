"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Sanitize an arbitrary identifier into a safe filename stem.
 */
function safeId(name) {
    return String(name || "default").trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

/**
 * Walk upward from cwd to locate the nearest git repository root, falling back to cwd.
 */
function findProjectRoot(cwd = process.cwd()) {
    let dir = path.resolve(cwd);
    while (true) {
        if (fs.existsSync(path.join(dir, ".git"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return path.resolve(cwd);
        dir = parent;
    }
}

/**
 * Resolve all global (~/.config/kovence) and per-project (<project>/.kovence) paths.
 */
function resolvePaths(options = {}) {
    const cwd = path.resolve(options.cwd || process.cwd());
    const projectRoot = path.resolve(options.projectRoot || findProjectRoot(cwd));
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const globalDir = path.resolve(
        options.globalDir || process.env.KOVENCE_CONFIG_DIR || path.join(xdgConfig, "kovence")
    );
    const projectDir = path.resolve(options.projectDir || path.join(projectRoot, ".kovence"));

    return {
        cwd,
        projectRoot,
        globalDir,
        projectDir,
        sessionsDir: path.join(projectDir, "sessions"),
        checkpointsDir: path.join(projectDir, "checkpoints"),
        commandsDir: path.join(projectDir, "commands"),
        settingsFile: path.join(globalDir, "settings.json"),
        providersFile: path.join(globalDir, "providers.json"),
        globalMemoryFile: path.join(globalDir, "global_memory.json"),
        globalPermissionsFile: path.join(globalDir, "permissions.json"),
        inputHistoryFile: path.join(globalDir, "input_history.json"),
        projectMemoryFile: path.join(projectDir, "project_memory.json"),
        projectPermissionsFile: path.join(projectDir, "permissions.json"),
        migrationMarkerFile: path.join(projectDir, ".migrated_from_ai_harness"),
    };
}

/**
 * Ensure .kovence/ is ignored via .git/info/exclude so user repos stay clean without editing .gitignore.
 */
function ensureGitInfoExclude(projectRoot) {
    try {
        const gitPath = path.join(projectRoot, ".git");
        if (!fs.existsSync(gitPath) || !fs.statSync(gitPath).isDirectory()) return false;
        const infoDir = path.join(gitPath, "info");
        const excludeFile = path.join(infoDir, "exclude");
        fs.mkdirSync(infoDir, { recursive: true });
        const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
        const lines = existing.split(/\r?\n/).map((l) => l.trim());
        if (lines.includes(".kovence") || lines.includes(".kovence/")) return false;
        const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
        fs.writeFileSync(excludeFile, `${existing}${prefix}.kovence/\n`, "utf8");
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensure global and project storage directories exist with appropriate permissions.
 */
function ensureStorageDirs(paths) {
    fs.mkdirSync(paths.globalDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.projectDir, { recursive: true });
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    ensureGitInfoExclude(paths.projectRoot);
}

/**
 * Read JSON file safely with a fallback when missing or corrupt.
 */
function readJsonSafe(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

/**
 * Atomically write JSON via temp file + rename and optional POSIX permissions mode.
 */
function atomicWriteJson(file, data, mode = null) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp.${path.basename(file)}.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", {
        encoding: "utf8",
        mode: mode ?? 0o644,
    });
    fs.renameSync(tmp, file);
    if (mode !== null) {
        try {
            fs.chmodSync(file, mode);
        } catch {
            // Non-POSIX filesystems may ignore chmod.
        }
    }
}

/**
 * Normalize legacy .ai_harness settings before saving to global Kovence settings.
 */
function sanitizeMigratedSettings(rawSettings) {
    if (!rawSettings || typeof rawSettings !== "object") return null;
    const next = { ...rawSettings };
    if (next.autoApprove === true && !next.agentMode) {
        next.agentMode = "auto";
    }
    delete next.autoApprove;
    if (typeof next.systemPrompt === "string") {
        next.systemPrompt = next.systemPrompt
            .split("\n")
            .filter((line) => !line.startsWith("Workspace: "))
            .join("\n");
    }
    return next;
}

/**
 * Migrate data once from legacy .ai_harness/ dirs into ~/.config/kovence and <project>/.kovence.
 * Never overwrites newer data and keeps the legacy directory intact as a backup.
 */
function migrateLegacyAiHarness(paths) {
    if (fs.existsSync(paths.migrationMarkerFile)) return { migrated: false, reason: "already-migrated" };

    const candidates = Array.from(
        new Set([
            path.join(paths.cwd, ".ai_harness"),
            path.join(paths.projectRoot, ".ai_harness"),
        ])
    ).filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());

    if (candidates.length === 0) return { migrated: false, reason: "no-legacy-dir" };

    ensureStorageDirs(paths);
    const summary = {
        migratedAt: new Date().toISOString(),
        sources: candidates,
        sessionsCopied: 0,
        memoryMerged: 0,
        settingsMigrated: false,
        providersMigrated: 0,
    };

    for (const legacyDir of candidates) {
        // 1. Sessions -> <project>/.kovence/sessions (copy without overwriting)
        const legacySessions = path.join(legacyDir, "sessions");
        if (fs.existsSync(legacySessions)) {
            for (const entry of fs.readdirSync(legacySessions)) {
                if (!entry.endsWith(".json")) continue;
                const src = path.join(legacySessions, entry);
                const dest = path.join(paths.sessionsDir, safeId(entry.replace(/\.json$/, "")) + ".json");
                if (!fs.existsSync(dest)) {
                    const data = readJsonSafe(src, null);
                    if (data) {
                        atomicWriteJson(dest, data);
                        summary.sessionsCopied += 1;
                    }
                }
            }
        }

        // 2. Global memory -> ~/.config/kovence/global_memory.json (deduped merge)
        const legacyMem = readJsonSafe(path.join(legacyDir, "global_memory.json"), null);
        if (legacyMem && Array.isArray(legacyMem.items) && legacyMem.items.length > 0) {
            const current = readJsonSafe(paths.globalMemoryFile, { items: [] });
            const existingItems = Array.isArray(current.items) ? current.items : [];
            const seen = new Set(
                existingItems.map((x) => String(typeof x === "string" ? x : x?.text || "").trim().toLowerCase())
            );
            let added = 0;
            for (const rawItem of legacyMem.items) {
                const text = String(typeof rawItem === "string" ? rawItem : rawItem?.text || "").trim();
                if (!text || seen.has(text.toLowerCase())) continue;
                seen.add(text.toLowerCase());
                existingItems.push({
                    text,
                    createdAt: (typeof rawItem === "object" && rawItem?.createdAt) || new Date().toISOString(),
                    source: "migrated",
                });
                added += 1;
            }
            if (added > 0) {
                atomicWriteJson(paths.globalMemoryFile, {
                    updatedAt: new Date().toISOString(),
                    items: existingItems,
                });
                summary.memoryMerged += added;
            }
        }

        // 3. Settings -> ~/.config/kovence/settings.json (only if absent)
        if (!fs.existsSync(paths.settingsFile)) {
            const legacySettings = readJsonSafe(path.join(legacyDir, "settings.json"), null);
            const cleaned = sanitizeMigratedSettings(legacySettings);
            if (cleaned) {
                atomicWriteJson(paths.settingsFile, cleaned);
                summary.settingsMigrated = true;
            }
        }

        // 4. Providers -> ~/.config/kovence/providers.json (strip env 'default', chmod 600)
        const legacyProv = readJsonSafe(path.join(legacyDir, "providers.json"), null);
        if (legacyProv && legacyProv.providers && typeof legacyProv.providers === "object") {
            const currentProv = readJsonSafe(paths.providersFile, { active: "default", providers: {} });
            const merged = { ...(currentProv.providers || {}) };
            let count = 0;
            for (const [key, val] of Object.entries(legacyProv.providers)) {
                if (key === "default" || !val || typeof val !== "object") continue;
                if (!merged[key]) {
                    merged[key] = { ...val, name: safeId(key) };
                    count += 1;
                }
            }
            const nextActive =
                currentProv.active && (currentProv.active === "default" || merged[currentProv.active])
                    ? currentProv.active
                    : legacyProv.active && merged[legacyProv.active]
                      ? legacyProv.active
                      : "default";
            if (count > 0 || !fs.existsSync(paths.providersFile)) {
                atomicWriteJson(paths.providersFile, { active: nextActive, providers: merged }, 0o600);
                summary.providersMigrated += count;
            }
        }
    }

    atomicWriteJson(paths.migrationMarkerFile, summary);
    return { migrated: true, summary };
}

module.exports = {
    safeId,
    findProjectRoot,
    resolvePaths,
    ensureGitInfoExclude,
    ensureStorageDirs,
    readJsonSafe,
    atomicWriteJson,
    migrateLegacyAiHarness,
};
