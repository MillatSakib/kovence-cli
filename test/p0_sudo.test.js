"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { rewriteSudoForAskpass, createEphemeralAskpass, runWithSudo } = require("../src/tools/sudo");

test("rewriteSudoForAskpass injects -A across single, chained, piped, and -S sudo commands", () => {
    assert.equal(rewriteSudoForAskpass("sudo apt update"), "sudo -A apt update");
    assert.equal(
        rewriteSudoForAskpass("sudo apt update && sudo dpkg -i app.deb"),
        "sudo -A apt update && sudo -A dpkg -i app.deb"
    );
    assert.equal(rewriteSudoForAskpass("echo hi | sudo tee /etc/test"), "echo hi | sudo -A tee /etc/test");
    assert.equal(rewriteSudoForAskpass("sudo -S apt install -y git"), "sudo -A apt install -y git");
    assert.equal(rewriteSudoForAskpass("sudo -n true"), "sudo -n true");
    assert.equal(rewriteSudoForAskpass("sudo -A ls"), "sudo -A ls");
});

test("createEphemeralAskpass preserves special characters, uses 0700/0600 permissions, and cleans up completely", () => {
    const trickyPw = `p@ss'w"or$d !#&`;
    const helper = createEphemeralAskpass(trickyPw);

    assert.equal(fs.statSync(helper.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(helper.pwFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(helper.scriptFile).mode & 0o777, 0o700);

    const out = execFileSync(helper.scriptFile, { encoding: "utf8" });
    assert.equal(out, `${trickyPw}\n`);

    helper.cleanup();
    assert.equal(fs.existsSync(helper.dir), false);
});

test("runWithSudo prompts on-time, retries on wrong password, runs chained sudo via SUDO_ASKPASS, and cleans up", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-sudo-test-"));
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

    // Fake sudo shim that enforces -n failure and validates -A via $SUDO_ASKPASS
    const fakeSudo = path.join(binDir, "sudo");
    fs.writeFileSync(
        fakeSudo,
        `#!/bin/sh
if [ "$1" = "-n" ]; then
  exit 1
fi
if [ "$1" != "-A" ]; then
  echo "sudo: a terminal is required to read the password" >&2
  exit 1
fi
shift
PW="$("$SUDO_ASKPASS")"
if [ "$PW" != "secret123!" ]; then
  echo "sudo: Authentication failed, try again." >&2
  exit 1
fi
exec "$@"
`,
        { mode: 0o755 }
    );

    let cachedPw = "";
    const prompts = [];
    const warnings = [];
    const answers = ["wrongpw", "secret123!"];
    const ctx = {
        getSudoPassword: () => cachedPw,
        setSudoPassword: (p) => {
            cachedPw = p || "";
        },
        askPassword: async (label) => {
            prompts.push(label);
            return answers.shift() || "";
        },
        log: (kind, text) => {
            if (kind === "error") warnings.push(text);
        },
        setBusy: () => {},
    };

    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    const out = await runWithSudo("sudo echo STEP1 && sudo echo STEP2", {
        cwd: tmp,
        timeout: 10000,
        ctx,
        env,
    });

    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /\[sudo\] password/i);
    assert.match(prompts[1], /Password incorrect/i);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Sudo password incorrect/i);
    assert.match(out, /STEP1/);
    assert.match(out, /STEP2/);
    assert.equal(cachedPw, "secret123!");
});
