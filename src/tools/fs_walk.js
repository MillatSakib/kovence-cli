"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ALWAYS_SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".ai_harness",
    ".ai_sessions",
    ".kovence",
    "dist",
    "build",
    "__pycache__",
]);

/**
 * Compile minimal .gitignore lines within a directory into predicates.
 */
function parseGitignoreFile(gitignorePath, relDir) {
    if (!fs.existsSync(gitignorePath)) return [];
    let raw;
    try {
        raw = fs.readFileSync(gitignorePath, "utf8");
    } catch {
        return [];
    }
    const rules = [];
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const negated = line.startsWith("!");
        let pat = negated ? line.slice(1).trim() : line;
        if (!pat) continue;
        const dirOnly = pat.endsWith("/");
        if (dirOnly) pat = pat.slice(0, -1);
        const anchored = pat.startsWith("/");
        if (anchored) pat = pat.slice(1);
        const hasSlash = pat.includes("/");

        const escaped = pat
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*/g, "__GLOBSTAR__")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]")
            .replace(/__GLOBSTAR__/g, ".*");

        const re = anchored || hasSlash ? new RegExp(`^${escaped}(?:/.*)?$`) : new RegExp(`(^|/)${escaped}(?:/.*)?$`);

        rules.push({ negated, dirOnly, relBase: relDir, re });
    }
    return rules;
}

function isIgnoredByRules(relPathFromRoot, isDir, rules) {
    const norm = relPathFromRoot.replace(/\\/g, "/");
    let ignored = false;
    for (const rule of rules) {
        let localRel = norm;
        if (rule.relBase) {
            if (!norm.startsWith(rule.relBase + "/")) continue;
            localRel = norm.slice(rule.relBase.length + 1);
        }
        if (rule.dirOnly && !isDir) {
            // Also check parent directory path prefix match via (?:/.*)?$
            if (!localRel.includes("/")) continue;
        }
        if (rule.re.test(localRel)) {
            ignored = !rule.negated;
        }
    }
    return ignored;
}

/**
 * Convert a user glob pattern to a relative-path RegExp.
 */
function globToRegex(glob) {
    const clean = String(glob || "*")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "");
    const esc = clean
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "__GLOBSTAR__")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/__GLOBSTAR__/g, ".*");
    if (clean.includes("/")) {
        return new RegExp(`^(?:.*/)?${esc}$`);
    }
    return new RegExp(`(^|/)${esc}$`);
}

/**
 * Traverse workspace directories respecting .gitignore, handling 5000+ files without stack overflow.
 */
function walkWorkspace(baseDir, options = {}) {
    const root = path.resolve(baseDir);
    const maxDepth = options.maxDepth ?? 16;
    const maxEntries = options.maxEntries ?? 10000;
    const includeDirs = options.includeDirs ?? true;
    const cwdRoot = path.resolve(options.cwdRoot || root);

    const results = [];
    let truncated = false;
    const stack = [{ dir: root, depth: 0, rules: [] }];

    while (stack.length > 0) {
        if (results.length >= maxEntries) {
            truncated = true;
            break;
        }
        const { dir, depth, rules } = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        const relDir = path.relative(root, dir).replace(/\\/g, "/");
        const localRules = [...rules, ...parseGitignoreFile(path.join(dir, ".gitignore"), relDir)];

        entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || b.name.localeCompare(a.name));
        // Push in reverse so stack pops alphabetically with directories/files ordered naturally
        const subdirsToPush = [];
        const sortedAsc = [...entries].reverse();

        for (const entry of sortedAsc) {
            if (results.length >= maxEntries) {
                truncated = true;
                break;
            }
            const isDir = entry.isDirectory();
            if (isDir && ALWAYS_SKIP_DIRS.has(entry.name)) continue;

            const full = path.join(dir, entry.name);
            const relFromWalkRoot = path.relative(root, full).replace(/\\/g, "/");
            if (isIgnoredByRules(relFromWalkRoot, isDir, localRules)) continue;

            const relFromCwd = path.relative(cwdRoot, full).replace(/\\/g, "/") || ".";
            if (isDir) {
                if (includeDirs) results.push(`${relFromCwd}/`);
                if (depth + 1 < maxDepth) {
                    subdirsToPush.push({ dir: full, depth: depth + 1, rules: localRules });
                }
            } else {
                results.push(relFromCwd);
            }
        }

        for (let i = subdirsToPush.length - 1; i >= 0; i--) {
            stack.push(subdirsToPush[i]);
        }
    }

    return { entries: results, truncated };
}

module.exports = {
    ALWAYS_SKIP_DIRS,
    globToRegex,
    walkWorkspace,
};
