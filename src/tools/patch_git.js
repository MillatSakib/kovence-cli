"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { scrubChildEnv } = require("./exec");

const execFileAsync = promisify(execFile);

/**
 * Parse a standard unified diff into per-file hunk structures.
 */
function parseUnifiedDiff(patchText) {
    const lines = String(patchText || "").replace(/\r\n/g, "\n").split("\n");
    const files = [];
    let current = null;
    let currentHunk = null;

    const stripPrefix = (p) => p.replace(/^[ab]\//, "").trim();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("--- ")) {
            const next = lines[i + 1] || "";
            if (next.startsWith("+++ ")) {
                if (current) files.push(current);
                const oldPath = stripPrefix(line.slice(4).split("\t")[0]);
                const newPath = stripPrefix(next.slice(4).split("\t")[0]);
                current = {
                    oldPath,
                    newPath,
                    targetPath: newPath === "/dev/null" ? oldPath : newPath,
                    isCreate: oldPath === "/dev/null",
                    isDelete: newPath === "/dev/null",
                    hunks: [],
                };
                currentHunk = null;
                i++;
                continue;
            }
        }
        const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
        if (hunkMatch && current) {
            currentHunk = {
                oldStart: Number(hunkMatch[1]),
                oldCount: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
                newStart: Number(hunkMatch[3]),
                newCount: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
                lines: [],
            };
            current.hunks.push(currentHunk);
            continue;
        }
        if (currentHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line === "\\ No newline at end of file")) {
            currentHunk.lines.push(line);
        }
    }
    if (current) files.push(current);
    return files;
}

function applyHunksToLines(origLines, hunks, filePathLabel) {
    const result = [...origLines];
    let offset = 0;

    for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
        const hunk = hunks[hIdx];
        const expectedOld = [];
        const replacement = [];

        for (const hl of hunk.lines) {
            if (hl.startsWith("\\")) continue;
            if (hl.startsWith(" ")) {
                expectedOld.push(hl.slice(1));
                replacement.push(hl.slice(1));
            } else if (hl.startsWith("-")) {
                expectedOld.push(hl.slice(1));
            } else if (hl.startsWith("+")) {
                replacement.push(hl.slice(1));
            }
        }

        const approxIdx = Math.max(0, hunk.oldStart - 1 + offset);
        let matchIdx = -1;

        const matchesAt = (idx) => {
            if (idx < 0 || idx + expectedOld.length > result.length) return false;
            for (let k = 0; k < expectedOld.length; k++) {
                if (result[idx + k] !== expectedOld[k]) return false;
            }
            return true;
        };

        if (matchesAt(approxIdx)) {
            matchIdx = approxIdx;
        } else {
            for (let delta = 1; delta <= 40; delta++) {
                if (matchesAt(approxIdx - delta)) {
                    matchIdx = approxIdx - delta;
                    break;
                }
                if (matchesAt(approxIdx + delta)) {
                    matchIdx = approxIdx + delta;
                    break;
                }
            }
        }

        if (matchIdx === -1) {
            throw new Error(`Patch hunk #${hIdx + 1} failed to match context in ${filePathLabel}`);
        }
        result.splice(matchIdx, expectedOld.length, ...replacement);
        offset += replacement.length - expectedOld.length;
    }

    return result.join("\n");
}

/**
 * Validate and apply a unified diff patch atomically across workspace files.
 */
function applyUnifiedPatch({ patch, workspaceRoot, assertFileAccess, onBeforeMutate }) {
    const filePatches = parseUnifiedDiff(patch);
    if (!filePatches.length) {
        throw new Error("Invalid or empty unified diff patch (expected --- / +++ / @@ headers).");
    }

    const planned = [];
    for (const fp of filePatches) {
        if (!fp.targetPath || fp.targetPath === "/dev/null") {
            throw new Error("Patch missing valid target file path.");
        }
        const abs = path.resolve(workspaceRoot, fp.targetPath);
        assertFileAccess?.(abs, "apply_patch");

        if (fp.isDelete) {
            if (!fs.existsSync(abs)) throw new Error(`Cannot delete missing file: ${fp.targetPath}`);
            planned.push({ abs, rel: fp.targetPath, op: "delete", nextContent: "" });
        } else if (fp.isCreate) {
            const addedLines = [];
            for (const h of fp.hunks) {
                for (const hl of h.lines) {
                    if (hl.startsWith("+")) addedLines.push(hl.slice(1));
                }
            }
            planned.push({ abs, rel: fp.targetPath, op: "write", nextContent: addedLines.join("\n") + (addedLines.length ? "\n" : "") });
        } else {
            if (!fs.existsSync(abs)) throw new Error(`Target file not found: ${fp.targetPath}`);
            const raw = fs.readFileSync(abs, "utf8");
            const nextContent = applyHunksToLines(raw.split(/\r?\n/), fp.hunks, fp.targetPath);
            planned.push({ abs, rel: fp.targetPath, op: "write", nextContent });
        }
    }

    onBeforeMutate?.(planned.map((p) => p.abs));

    const summary = [];
    for (const p of planned) {
        if (p.op === "delete") {
            fs.unlinkSync(p.abs);
            summary.push(`deleted ${p.rel}`);
        } else {
            fs.mkdirSync(path.dirname(p.abs), { recursive: true });
            fs.writeFileSync(p.abs, p.nextContent, "utf8");
            summary.push(`patched ${p.rel}`);
        }
    }
    return summary;
}

async function execGitReadOnly(args, workspaceRoot) {
    const env = scrubChildEnv(process.env);
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd: workspaceRoot,
            env,
            timeout: 10000,
            maxBuffer: 1024 * 1024,
        });
        return [stdout, stderr].filter(Boolean).join("\n").trim();
    } catch (err) {
        const msg = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
        throw new Error(msg || "git command failed");
    }
}

module.exports = {
    parseUnifiedDiff,
    applyUnifiedPatch,
    execGitReadOnly,
};
