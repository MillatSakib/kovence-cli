"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnShell } = require("./exec");

const AUTH_FAIL_RE =
    /authentication failed|authentication failure|incorrect password|sorry, try again|try again|no password was provided|pam_authenticate|1 incorrect password attempt|3 incorrect password attempts/i;

/**
 * Rewrite `sudo` invocations in a shell command to use `-A` (SUDO_ASKPASS)
 * so compound commands, pipes, and non-TTY detached process groups all work reliably.
 */
function rewriteSudoForAskpass(command) {
    let cmd = String(command || "");
    // Remove bare -S flags (stdin password mode conflicts with pipes & askpass)
    cmd = cmd.replace(/(^|[;&|(\s])sudo\s+-S(?=\s)/g, "$1sudo");
    // Inject -A on every sudo invocation unless -A or -n is already present
    cmd = cmd.replace(/(^|[;&|(\s])sudo(?=\s|$)(?!\s+-[A-Za-z]*[An])/g, "$1sudo -A");
    return cmd;
}

/**
 * Create an ephemeral 0700 temp directory with a 0600 password file and 0700 askpass script.
 * When `oneShot` is true, the script supplies the password only on the first call and exits 1
 * on subsequent retries within the same sudo process, avoiding 3x PAM lock delays on wrong passwords.
 */
function createEphemeralAskpass(password, { oneShot = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kovence-askpass-"));
    try {
        fs.chmodSync(dir, 0o700);
    } catch {}

    const pwFile = path.join(dir, "pw");
    const usedFile = path.join(dir, "used");
    const scriptFile = path.join(dir, "askpass.sh");

    fs.writeFileSync(pwFile, `${password}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        fs.chmodSync(pwFile, 0o600);
    } catch {}

    const safePwPath = pwFile.replace(/'/g, "'\\''");
    const safeUsedPath = usedFile.replace(/'/g, "'\\''");
    const script = oneShot
        ? `#!/bin/sh\nif [ -f '${safeUsedPath}' ]; then exit 1; fi\n: > '${safeUsedPath}'\ncat '${safePwPath}'\n`
        : `#!/bin/sh\ncat '${safePwPath}'\n`;

    fs.writeFileSync(scriptFile, script, { encoding: "utf8", mode: 0o700 });
    try {
        fs.chmodSync(scriptFile, 0o700);
    } catch {}

    const cleanup = () => {
        try {
            if (fs.existsSync(pwFile)) {
                fs.writeFileSync(pwFile, "\0".repeat(Math.max(32, password.length + 1)), { mode: 0o600 });
            }
        } catch {}
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
    };

    return { dir, pwFile, scriptFile, cleanup };
}

/**
 * Check if passwordless sudo works in the SAME detached execution context as spawnShell.
 */
async function canRunPasswordlessSudo({ cwd, env, signal }) {
    const check = await spawnShell("sudo -n true", { cwd, timeout: 2500, signal, env });
    return !check.aborted && !check.timedOut && check.code === 0;
}

/**
 * Verify a candidate sudo password quickly with a 1-shot askpass helper before executing the real command.
 */
async function verifySudoPassword(password, { cwd, env, signal }) {
    const askpass = createEphemeralAskpass(password, { oneShot: true });
    try {
        const res = await spawnShell("sudo -A true", {
            cwd,
            timeout: 8000,
            signal,
            env: { ...env, SUDO_ASKPASS: askpass.scriptFile },
        });
        if (res.aborted) return { ok: false, aborted: true };
        if (res.code === 0) return { ok: true };
        const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
        return {
            ok: false,
            authFailed: AUTH_FAIL_RE.test(combined) || res.code === 1,
            output: combined,
        };
    } finally {
        askpass.cleanup();
    }
}

/**
 * Execute a shell command containing `sudo`, prompting interactively for the password when needed,
 * showing a clear warning and re-prompting whenever the password is wrong.
 */
async function runWithSudo(command, { cwd, timeout, ctx, env, onData = null, capOutput = (s) => s } = {}) {
    if (await canRunPasswordlessSudo({ cwd, env, signal: ctx?.signal })) {
        return null;
    }

    const rewritten = rewriteSudoForAskpass(command);
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (ctx?.signal?.aborted) return "Command aborted by user.";

        let pw = ctx?.getSudoPassword?.() || "";
        let promptedNow = false;
        if (!pw) {
            if (!ctx?.askPassword) {
                throw new Error("sudo password required but interactive prompt unavailable.");
            }
            const label =
                attempt === 0
                    ? `[sudo] password required (masked): `
                    : `[sudo] Password incorrect! Enter sudo password again (${attempt + 1}/${maxAttempts}): `;
            ctx?.setBusy?.(attempt === 0 ? "Waiting for sudo password..." : "Password incorrect — waiting for retry...");
            pw = await ctx.askPassword(label);
            promptedNow = true;
            if (ctx?.signal?.aborted) return "Command aborted by user.";
            if (!pw) throw new Error("sudo cancelled by user (empty password).");
        }

        ctx?.setBusy?.("Verifying sudo password...");
        const check = await verifySudoPassword(pw, { cwd, env, signal: ctx?.signal });
        if (check.aborted) return "Command aborted by user.";
        if (!check.ok) {
            ctx?.setSudoPassword?.(null);
            // If a previously cached password expired/failed, don't count it against user's interactive attempts
            if (!promptedNow) {
                attempt -= 1;
                continue;
            }
            const remaining = maxAttempts - (attempt + 1);
            if (remaining > 0) {
                ctx?.log?.(
                    "error",
                    `⚠ Sudo password incorrect! Please try again (${remaining} attempt${remaining > 1 ? "s" : ""} remaining).`
                );
                continue;
            }
            ctx?.log?.("error", "✖ Sudo authentication failed after 3 incorrect password attempts.");
            throw new Error("sudo authentication failed after 3 incorrect password attempts.");
        }

        // Password verified! Cache it for the session and run the actual command
        ctx?.setSudoPassword?.(pw);
        const askpass = createEphemeralAskpass(pw, { oneShot: false });
        ctx?.setBusy?.("Running sudo command...");
        let res;
        try {
            const sudoEnv = {
                ...env,
                SUDO_ASKPASS: askpass.scriptFile,
                DEBIAN_FRONTEND: env?.DEBIAN_FRONTEND || "noninteractive",
            };
            res = await spawnShell(rewritten, {
                cwd,
                timeout,
                signal: ctx?.signal,
                env: sudoEnv,
                onData,
            });
        } finally {
            askpass.cleanup();
        }

        if (res.aborted) return "Command aborted by user.";
        const scrub = (s) => (pw ? String(s).split(pw).join("[REDACTED]") : String(s));
        const combined = scrub([res.stdout, res.stderr].filter(Boolean).join("\n").trim());

        if (res.code !== 0 && AUTH_FAIL_RE.test(combined)) {
            ctx?.setSudoPassword?.(null);
            if (attempt + 1 < maxAttempts) {
                ctx?.log?.("error", "⚠ Sudo password incorrect! Please try again.");
                continue;
            }
            throw new Error("sudo authentication failed (incorrect password).");
        }

        if (res.timedOut) {
            return capOutput(`Command timed out after ${Math.round(timeout / 1000)}s:\n${combined}`.trim());
        }
        if (res.code === 0) {
            return capOutput(combined || "(sudo command exited 0 with no output)");
        }
        return capOutput(`Exit ${res.code ?? "error"}:\n${combined}`);
    }

    throw new Error("sudo authentication failed.");
}

module.exports = {
    AUTH_FAIL_RE,
    rewriteSudoForAskpass,
    createEphemeralAskpass,
    canRunPasswordlessSudo,
    verifySudoPassword,
    runWithSudo,
};
