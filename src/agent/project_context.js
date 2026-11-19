"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_INSTRUCTION_CHARS = 12000;

/**
 * Read current git branch directly from .git/HEAD when inside a git repository.
 */
function readGitBranch(workspaceRoot) {
    try {
        const headPath = path.join(workspaceRoot, ".git", "HEAD");
        if (!fs.existsSync(headPath)) return "";
        const raw = fs.readFileSync(headPath, "utf8").trim();
        const m = raw.match(/^ref:\s*refs\/heads\/(.+)$/);
        return m ? m[1] : raw.slice(0, 12);
    } catch {
        return "";
    }
}

/**
 * Collect concise runtime environment facts for the system prompt.
 */
function gatherEnvironmentSummary(workspaceRoot = process.cwd()) {
    const branch = readGitBranch(workspaceRoot);
    const parts = [
        `OS: ${os.type()} ${os.release()} (${process.arch})`,
        `Node: ${process.version}`,
        `Date: ${new Date().toISOString().slice(0, 10)}`,
    ];
    if (branch) parts.push(`Git Branch: ${branch}`);
    return parts.join(" · ");
}

/**
 * Auto-load project instruction files (KOVENCE.md, AGENTS.md, .kovence/KOVENCE.md).
 */
function loadProjectInstructions(workspaceRoot = process.cwd()) {
    const candidates = [
        path.join(workspaceRoot, "KOVENCE.md"),
        path.join(workspaceRoot, "AGENTS.md"),
        path.join(workspaceRoot, ".kovence", "KOVENCE.md"),
    ];
    const sections = [];
    let total = 0;

    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile()) continue;
            const raw = fs.readFileSync(file, "utf8").trim();
            if (!raw) continue;
            const remain = MAX_INSTRUCTION_CHARS - total;
            if (remain <= 0) break;
            const slice = raw.slice(0, remain);
            total += slice.length;
            const rel = path.relative(workspaceRoot, file);
            sections.push(`[Project Instructions: ${rel}]\n${slice}`);
        } catch {
            // Skip unreadable file cleanly.
        }
    }
    return sections.join("\n\n");
}

/**
 * Scan workspace metadata and generate a starter KOVENCE.md project guide (/init).
 */
function generateProjectInitDoc(workspaceRoot = process.cwd()) {
    const projectName = path.basename(workspaceRoot);
    const tech = [];
    const commands = [];

    const pkgFile = path.join(workspaceRoot, "package.json");
    if (fs.existsSync(pkgFile)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
            tech.push(`Node.js (${pkg.name || projectName})`);
            if (pkg.scripts && typeof pkg.scripts === "object") {
                for (const [k, v] of Object.entries(pkg.scripts)) {
                    commands.push(`- \`npm run ${k}\`: \`${v}\``);
                }
            }
        } catch {
            tech.push("Node.js");
        }
    }
    if (
        fs.existsSync(path.join(workspaceRoot, "pyproject.toml")) ||
        fs.existsSync(path.join(workspaceRoot, "requirements.txt"))
    ) {
        tech.push("Python");
    }
    if (fs.existsSync(path.join(workspaceRoot, "Cargo.toml"))) tech.push("Rust");
    if (fs.existsSync(path.join(workspaceRoot, "go.mod"))) tech.push("Go");

    let topEntries = [];
    try {
        topEntries = fs
            .readdirSync(workspaceRoot, { withFileTypes: true })
            .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
            .slice(0, 20)
            .map((e) => `- \`${e.name}${e.isDirectory() ? "/" : ""}\``);
    } catch {}

    return [
        `# KOVENCE.md — ${projectName}`,
        "",
        "Project instructions automatically loaded by Kovence CLI.",
        "",
        "## Stack",
        tech.length ? tech.map((t) => `- ${t}`).join("\n") : "- General workspace",
        "",
        "## Structure",
        topEntries.length ? topEntries.join("\n") : "- (empty workspace)",
        "",
        "## Commands",
        commands.length ? commands.join("\n") : "- Add build/test/lint commands here",
        "",
        "## Conventions",
        "- Keep changes minimal, tested, and aligned with existing code style.",
        "- Run relevant checks before concluding a task.",
        "",
    ].join("\n");
}

module.exports = {
    readGitBranch,
    gatherEnvironmentSummary,
    loadProjectInstructions,
    generateProjectInitDoc,
};
