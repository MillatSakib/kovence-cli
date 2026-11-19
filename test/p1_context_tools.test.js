"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { executeTool } = require("../tools");
const { resolvePaths } = require("../src/config/paths");
const { undoLastCheckpoint } = require("../src/tools/checkpoints");
const { gatherEnvironmentSummary, loadProjectInstructions, generateProjectInitDoc } = require("../src/agent/project_context");

test("F1: loads KOVENCE.md/AGENTS.md, gathers environment summary, and generates /init doc", (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-p1-f1-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ name: "sample-app", scripts: { test: "node --test" } }),
        "utf8"
    );
    const starter = generateProjectInitDoc(tmp);
    assert.match(starter, /# KOVENCE\.md — /);
    assert.match(starter, /npm run test/);

    fs.writeFileSync(path.join(tmp, "KOVENCE.md"), "Always run npm test before commit.", "utf8");
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "Use strict mode.", "utf8");

    const loaded = loadProjectInstructions(tmp);
    assert.match(loaded, /KOVENCE\.md/);
    assert.match(loaded, /Always run npm test/);
    assert.match(loaded, /AGENTS\.md/);

    const envText = gatherEnvironmentSummary(tmp);
    assert.match(envText, /Node: v\d+/);
});

test("F2: checkpoints & /undo restore write_file, edit_file, delete_file, move_file, and apply_patch", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-p1-f2-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const paths = resolvePaths({ cwd: tmp, projectRoot: tmp, globalDir: path.join(tmp, "cfg"), projectDir: path.join(tmp, ".kovence") });
    const ctx = {
        cwd: tmp,
        workspaceRoot: tmp,
        paths,
        session: { id: "s1" },
        _permissionChecked: true,
    };

    // 1. write_file creates new file -> undo removes it
    await executeTool("write_file", { path: "hello.txt", content: "v1\nline2\nline3\n" }, ctx);
    assert.equal(fs.existsSync(path.join(tmp, "hello.txt")), true);
    const undo1 = undoLastCheckpoint("s1", paths, tmp);
    assert.equal(undo1.ok, true);
    assert.equal(fs.existsSync(path.join(tmp, "hello.txt")), false);

    // 2. apply_patch updates file -> undo restores original
    fs.writeFileSync(path.join(tmp, "app.js"), "const a = 1;\nconst b = 2;\n", "utf8");
    const patch = [
        "--- a/app.js",
        "+++ b/app.js",
        "@@ -1,2 +1,2 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 42;",
    ].join("\n");
    await executeTool("apply_patch", { patch }, ctx);
    assert.match(fs.readFileSync(path.join(tmp, "app.js"), "utf8"), /const b = 42;/);

    const undo2 = undoLastCheckpoint("s1", paths, tmp);
    assert.equal(undo2.ok, true);
    assert.equal(fs.readFileSync(path.join(tmp, "app.js"), "utf8"), "const a = 1;\nconst b = 2;\n");

    // 3. mkdir + move_file + undo
    await executeTool("mkdir", { path: "nested/dir" }, ctx);
    assert.equal(fs.statSync(path.join(tmp, "nested/dir")).isDirectory(), true);
    await executeTool("move_file", { from: "app.js", to: "nested/dir/app.js" }, ctx);
    assert.equal(fs.existsSync(path.join(tmp, "app.js")), false);
    assert.equal(fs.existsSync(path.join(tmp, "nested/dir/app.js")), true);

    undoLastCheckpoint("s1", paths, tmp);
    assert.equal(fs.existsSync(path.join(tmp, "app.js")), true);
    assert.equal(fs.existsSync(path.join(tmp, "nested/dir/app.js")), false);
});

test("F2 + F3: git_status/git_diff/git_log work safely and ask_user works with options", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-p1-git-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "README.md"), "init\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmp });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tmp, stdio: "ignore" });

    fs.writeFileSync(path.join(tmp, "README.md"), "init\nupdated\n", "utf8");
    const status = await executeTool("git_status", {}, { cwd: tmp, workspaceRoot: tmp });
    const diff = await executeTool("git_diff", {}, { cwd: tmp, workspaceRoot: tmp });
    const log = await executeTool("git_log", { limit: 5 }, { cwd: tmp, workspaceRoot: tmp });

    assert.match(status, /README\.md/);
    assert.match(diff, /\+updated/);
    assert.match(log, /initial commit/);

    // ask_user works even in plan mode
    const ans = await executeTool(
        "ask_user",
        { question: "Which DB?", options: ["SQLite", "Postgres"] },
        {
            cwd: tmp,
            workspaceRoot: tmp,
            settings: { agentMode: "plan" },
            openChoicePicker: async () => "Postgres",
        }
    );
    assert.equal(ans, "Postgres");
});
