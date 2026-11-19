"use strict";

const { spawn } = require("node:child_process");
const { scrubChildEnv, killProcessGroup } = require("./exec");

const MAX_LOG_CHARS = 64000;

class BackgroundTaskManager {
    constructor({ onChange = null } = {}) {
        this.tasks = new Map();
        this.seq = 0;
        this.onChange = onChange;
    }

    startTask(command, { cwd = process.cwd(), env = null } = {}) {
        this.seq += 1;
        const id = String(this.seq);
        const child = spawn("sh", ["-c", command], {
            cwd,
            env: env || scrubChildEnv(process.env),
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });

        const task = {
            id,
            pid: child.pid,
            command: String(command),
            cwd,
            startedAt: new Date().toISOString(),
            endedAt: null,
            status: "running",
            exitCode: null,
            output: "",
            _child: child,
        };

        const appendOut = (chunk) => {
            task.output += chunk.toString("utf8");
            if (task.output.length > MAX_LOG_CHARS) {
                task.output = task.output.slice(-MAX_LOG_CHARS);
            }
        };

        child.stdout?.on("data", appendOut);
        child.stderr?.on("data", appendOut);
        child.on("close", (code) => {
            if (task.status === "running") {
                task.status = "exited";
            }
            task.exitCode = code;
            task.endedAt = new Date().toISOString();
            task._child = null;
            this.onChange?.();
        });
        child.on("error", (err) => {
            task.output += `\n[error: ${err.message}]`;
            task.status = "exited";
            task.exitCode = 1;
            task.endedAt = new Date().toISOString();
            task._child = null;
            this.onChange?.();
        });

        this.tasks.set(id, task);
        this.onChange?.();
        return this.serializeTask(task);
    }

    serializeTask(task) {
        return {
            id: task.id,
            pid: task.pid,
            command: task.command,
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            status: task.status,
            exitCode: task.exitCode,
            output: task.output,
        };
    }

    listTasks() {
        return [...this.tasks.values()].map((t) => this.serializeTask(t));
    }

    activeCount() {
        let count = 0;
        for (const t of this.tasks.values()) {
            if (t.status === "running") count += 1;
        }
        return count;
    }

    getTask(id) {
        const t = this.tasks.get(String(id));
        return t ? this.serializeTask(t) : null;
    }

    killTask(id) {
        const t = this.tasks.get(String(id));
        if (!t) return false;
        if (t.status === "running" && t._child) {
            t.status = "killed";
            killProcessGroup(t._child, "SIGTERM");
            setTimeout(() => {
                if (t._child) killProcessGroup(t._child, "SIGKILL");
            }, 300).unref?.();
            this.onChange?.();
            return true;
        }
        return false;
    }

    killAll() {
        for (const t of this.tasks.values()) {
            if (t.status === "running" && t._child) {
                t.status = "killed";
                killProcessGroup(t._child, "SIGTERM");
            }
        }
    }
}

module.exports = {
    BackgroundTaskManager,
};
