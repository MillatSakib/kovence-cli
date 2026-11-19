"use strict";

const { spawn } = require("node:child_process");

const SECRET_ENV_KEY_RE =
    /(?:^|_)(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|AUTH)(?:$|_)/i;

const EXTRA_SCRUB_KEYS = new Set([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LITELLM_API_KEY",
    "GOOGLE_API_KEY",
    "BRAVE_API_KEY",
    "TAVILY_API_KEY",
    "API_KEY",
]);

/**
 * Strip provider/API secrets from child process env so shell commands never expose user keys.
 */
function scrubChildEnv(baseEnv = process.env, extraKeys = []) {
    const clean = {};
    const extraSet = new Set(extraKeys.filter(Boolean).map((k) => String(k).trim()));
    for (const [k, v] of Object.entries(baseEnv || {})) {
        if (v === undefined) continue;
        if (EXTRA_SCRUB_KEYS.has(k) || extraSet.has(k)) continue;
        if (SECRET_ENV_KEY_RE.test(k) && !/^XDG_|^GNOME_|^DBUS_|^GPG_|^SSH_AUTH_SOCK$/i.test(k)) {
            continue;
        }
        clean[k] = v;
    }
    return clean;
}

/**
 * Kill a child process group cleanly (POSIX negative PID), falling back to direct kill.
 */
function killProcessGroup(child, sig = "SIGTERM") {
    if (!child || !child.pid) return;
    try {
        process.kill(-child.pid, sig);
    } catch {
        try {
            child.kill(sig);
        } catch {
            // Process may already have exited.
        }
    }
}

/**
 * Spawn shell command in its own process group with AbortSignal, timeout, and optional live streaming.
 */
function spawnShell(
    command,
    { cwd = process.cwd(), timeout = 15000, stdinText = null, signal = null, env = null, maxCapture = 64000, onData = null } = {}
) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({ code: "aborted", stdout: "", stderr: "Aborted before execution", timedOut: false, aborted: true });
            return;
        }

        const child = spawn("sh", ["-c", command], {
            cwd,
            env: env || scrubChildEnv(process.env),
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let forceKillTimer = null;

        const terminateTree = () => {
            killProcessGroup(child, "SIGTERM");
            forceKillTimer = setTimeout(() => {
                killProcessGroup(child, "SIGKILL");
            }, 300);
            forceKillTimer.unref?.();
        };

        const onAbort = () => {
            aborted = true;
            terminateTree();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
            timedOut = true;
            terminateTree();
        }, timeout);

        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            onData?.("stdout", text);
            if (stdout.length < maxCapture) stdout += text;
        });

        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            onData?.("stderr", text);
            if (stderr.length < maxCapture) stderr += text;
        });

        const finish = (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            signal?.removeEventListener("abort", onAbort);
            resolve({
                code: aborted ? "aborted" : timedOut ? "timeout" : code,
                stdout,
                stderr,
                timedOut,
                aborted,
            });
        };

        child.on("close", finish);
        child.on("error", (err) => {
            stderr += (stderr ? "\n" : "") + err.message;
            finish(1);
        });

        if (stdinText !== null && stdinText !== undefined) {
            child.stdin.write(stdinText);
        }
        child.stdin.end();
    });
}

module.exports = {
    scrubChildEnv,
    killProcessGroup,
    spawnShell,
};
