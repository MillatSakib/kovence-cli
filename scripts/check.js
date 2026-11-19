#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const IGNORE_DIRS = new Set(["node_modules", ".git", ".kovence", ".ai_harness", "coverage", "website", ".next", "out"]);

function collectJsFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectJsFiles(full, out);
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            out.push(full);
        }
    }
    return out;
}

const files = collectJsFiles(ROOT).sort();
for (const file of files) {
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`Syntax check passed for ${files.length} JS files.`);
