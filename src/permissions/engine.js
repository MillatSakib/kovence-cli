"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPermissionRules } = require("./store");
const { resolvePaths } = require("../config/paths");

const READ_TOOLS = new Set([
    "list_dir",
    "glob_files",
    "read_file",
    "search_files",
    "todo_write",
    "web_search",
    "google_search",
    "git_status",
    "git_diff",
    "git_log",
    "ask_user",
]);

const NETWORK_READ_TOOLS = new Set(["web_fetch", "web_search", "google_search"]);

const FILE_EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch", "move_file", "mkdir"]);

const FILE_PATH_TOOLS = new Set([
    "list_dir",
    "glob_files",
    "read_file",
    "search_files",
    "write_file",
    "edit_file",
    "multi_edit",
    "delete_file",
    "download_file",
    "apply_patch",
    "move_file",
    "mkdir",
]);

const MEMORY_WRITE_TOOLS = new Set(["save_session_memory", "save_global_memory", "delete_global_memory"]);

const PLAN_BLOCKED_TOOLS = new Set([
    ...FILE_EDIT_TOOLS,
    "delete_file",
    "download_file",
    ...MEMORY_WRITE_TOOLS,
    "undo_checkpoint",
]);

const READ_ONLY_BASE_COMMANDS = new Set([
    "ls",
    "ll",
    "la",
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "fd",
    "tree",
    "pwd",
    "uname",
    "which",
    "type",
    "whoami",
    "id",
    "date",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "file",
    "stat",
    "readlink",
    "realpath",
    "basename",
    "dirname",
    "df",
    "du",
    "free",
    "uptime",
    "ps",
    "echo",
    "printf",
    "printenv",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
    "status",
    "diff",
    "log",
    "show",
    "branch",
    "tag",
    "rev-parse",
    "ls-files",
    "grep",
    "blame",
    "describe",
    "remote",
]);

const TWO_WORD_PREFIX_TOOLS = new Set([
    "git",
    "npm",
    "npx",
    "yarn",
    "pnpm",
    "cargo",
    "docker",
    "kubectl",
    "pip",
    "pip3",
]);

/**
 * Resolve nearest realpath even when target file does not exist yet (catches symlink escapes).
 */
function resolveRealWithMissingLeaf(targetPath) {
    const abs = path.resolve(targetPath);
    const suffix = [];
    let cursor = abs;
    while (true) {
        try {
            const real = fs.realpathSync(cursor);
            return suffix.length ? path.join(real, ...suffix.reverse()) : real;
        } catch {
            const parent = path.dirname(cursor);
            if (parent === cursor) return abs;
            suffix.push(path.basename(cursor));
            cursor = parent;
        }
    }
}

function isWithinDir(targetPath, dirPath) {
    const realTarget = resolveRealWithMissingLeaf(targetPath);
    const realDir = resolveRealWithMissingLeaf(dirPath);
    const rel = path.relative(realDir, realTarget);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isPathInsideWorkspace(targetPath, workspaceRoot, extraDirs = []) {
    if (!targetPath) return true;
    const dirs = [workspaceRoot, ...(Array.isArray(extraDirs) ? extraDirs : [])].filter(Boolean);
    return dirs.some((dir) => isWithinDir(path.resolve(workspaceRoot, targetPath), dir));
}

function extractToolPaths(toolName, args, workspaceRoot) {
    const candidates = [];
    if (args?.path) candidates.push(args.path);
    if (args?.file) candidates.push(args.file);
    if (args?.from) candidates.push(args.from);
    if (args?.to) candidates.push(args.to);
    if (args?.destination) candidates.push(args.destination);
    return candidates
        .map((p) => {
            const str = String(p).trim();
            if (!str) return null;
            if (str.startsWith("~/")) return path.join(os.homedir(), str.slice(2));
            return path.resolve(workspaceRoot, str);
        })
        .filter(Boolean);
}

/**
 * Quote-aware shell parser splitting compound commands and flagging subshells/redirects.
 */
function parseShellCommand(command) {
    const src = String(command || "");
    const segments = [];
    let curTokens = [];
    let curToken = "";
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    let hasSubshell = false;
    let hasRedirect = false;

    const pushToken = () => {
        if (curToken.length > 0) {
            curTokens.push(curToken);
            curToken = "";
        }
    };
    const pushSegment = () => {
        pushToken();
        if (curTokens.length > 0) {
            segments.push(curTokens);
            curTokens = [];
        }
    };

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1] || "";

        if (escaped) {
            curToken += ch;
            escaped = false;
            continue;
        }
        if (inSingle) {
            if (ch === "'") inSingle = false;
            else curToken += ch;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (inDouble) {
            if (ch === '"') {
                inDouble = false;
                continue;
            }
            if ((ch === "$" && next === "(") || ch === "`") {
                hasSubshell = true;
            }
            curToken += ch;
            continue;
        }

        if (ch === "'") {
            inSingle = true;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            continue;
        }
        if ((ch === "$" && next === "(") || ch === "`" || ch === "(" || ch === ")") {
            hasSubshell = true;
            curToken += ch;
            continue;
        }
        if ((ch === "<" || ch === ">") && next === "(") {
            hasSubshell = true;
        }
        if (ch === ">" || (ch === "&" && next === ">") || (/\d/.test(ch) && next === ">" && curToken === "")) {
            hasRedirect = true;
            pushToken();
            if (next === ">") i++;
            continue;
        }
        if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
            pushSegment();
            i++;
            continue;
        }
        if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
            pushSegment();
            continue;
        }
        if (/\s/.test(ch)) {
            pushToken();
            continue;
        }
        curToken += ch;
    }
    pushSegment();

    return {
        segments,
        hasSubshell,
        hasRedirect,
        raw: src,
    };
}

/**
 * Strip leading VAR=val env assignments or sudo wrapper from a segment's token list.
 */
function stripSegmentLead(tokens) {
    let i = 0;
    let usesSudo = false;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
        i++;
    }
    if (tokens[i] === "sudo") {
        usesSudo = true;
        i++;
        while (i < tokens.length && tokens[i].startsWith("-")) {
            if (tokens[i] === "-u" || tokens[i] === "-g" || tokens[i] === "-p") i += 2;
            else i++;
        }
    }
    return { cmdTokens: tokens.slice(i), usesSudo };
}

function getSegmentPrefix(tokens) {
    const { cmdTokens } = stripSegmentLead(tokens);
    if (cmdTokens.length === 0) return "";
    const head = path.basename(cmdTokens[0]);
    if (TWO_WORD_PREFIX_TOOLS.has(head) && cmdTokens[1] && !cmdTokens[1].startsWith("-")) {
        return `${head} ${cmdTokens[1]}`;
    }
    return head;
}

/**
 * Verify a shell command is strictly read-only for Plan Mode.
 */
function isReadOnlyShellCommand(command) {
    const parsed = parseShellCommand(command);
    if (parsed.segments.length === 0) return false;
    if (parsed.hasSubshell || parsed.hasRedirect) return false;

    for (const seg of parsed.segments) {
        const { cmdTokens, usesSudo } = stripSegmentLead(seg);
        if (usesSudo || cmdTokens.length === 0) return false;
        const bin = path.basename(cmdTokens[0]);
        const rest = cmdTokens.slice(1);

        if (bin === "git") {
            const sub = rest.find((t) => !t.startsWith("-"));
            if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
            continue;
        }
        if (bin === "find") {
            if (rest.some((t) => /^-(delete|exec|execdir|ok|okdir|fls|fprint)/i.test(t))) return false;
            continue;
        }
        if (bin === "sed") {
            if (rest.some((t) => t === "-i" || t.startsWith("-i"))) return false;
            continue;
        }
        if (bin === "node") {
            if (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--version")) continue;
            return false;
        }
        if (bin === "npm") {
            const sub = rest.find((t) => !t.startsWith("-"));
            if (sub === "ls" || sub === "list" || sub === "view" || rest.includes("--version") || rest.includes("-v")) {
                continue;
            }
            return false;
        }
        if (!READ_ONLY_BASE_COMMANDS.has(bin)) return false;
    }
    return true;
}

function normalizeHomePath(p) {
    const s = String(p || "").trim();
    if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
    return path.resolve(s);
}

function isProtectedConfigPath(filePath) {
    const home = os.homedir();
    const resolved = resolveRealWithMissingLeaf(normalizeHomePath(filePath));
    const criticalFiles = [".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".bash_login"].map((f) =>
        path.join(home, f)
    );
    if (criticalFiles.some((f) => resolved === f)) return "Shell startup config (~/.bashrc / ~/.zshrc / ~/.profile)";
    if (isWithinDir(resolved, path.join(home, ".ssh"))) return "SSH directory (~/.ssh)";
    if (["/etc/passwd", "/etc/shadow", "/etc/sudoers"].includes(resolved) || resolved.startsWith("/etc/sudoers.d/")) {
        return `Critical system file (${resolved})`;
    }
    return null;
}

function isSecretFilePath(filePath) {
    const resolved = resolveRealWithMissingLeaf(normalizeHomePath(filePath));
    const base = path.basename(resolved).toLowerCase();
    const home = os.homedir();

    if (/^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template)$/.test(base)) {
        return `Environment secret file (${base})`;
    }
    if (/\.(pem|key|p12|pfx)$/i.test(base) || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].includes(base)) {
        return `Private key / certificate file (${base})`;
    }
    const sensitiveHomePaths = [
        path.join(home, ".ssh"),
        path.join(home, ".aws", "credentials"),
        path.join(home, ".aws", "config"),
        path.join(home, ".npmrc"),
        path.join(home, ".netrc"),
        path.join(home, ".pypirc"),
        path.join(home, ".docker", "config.json"),
        path.join(home, ".gnupg"),
    ];
    for (const sPath of sensitiveHomePaths) {
        if (resolved === sPath || isWithinDir(resolved, sPath)) {
            return `Sensitive credential store (${sPath})`;
        }
    }
    return null;
}

/**
 * Hard denylist that ALWAYS prompts user confirmation regardless of mode or saved rules.
 * In `auto` mode, only catastrophic system/data-destruction patterns remain on the hard denylist;
 * normal package operations and workspace file inspections are allowed seamlessly.
 */
function checkHardDenylist(toolName, args, workspaceRoot, isAutoMode = false) {
    if (FILE_PATH_TOOLS.has(toolName)) {
        const paths = extractToolPaths(toolName, args, workspaceRoot);
        for (const p of paths) {
            if (!isAutoMode) {
                const secretReason = isSecretFilePath(p);
                if (secretReason) return secretReason;
            }
            if (
                toolName !== "read_file" &&
                toolName !== "list_dir" &&
                toolName !== "glob_files" &&
                toolName !== "search_files"
            ) {
                const protReason = isProtectedConfigPath(p);
                if (protReason) return protReason;
            }
        }
    }

    if (toolName !== "run_command") return null;
    const cmd = String(args?.command || "");
    const parsed = parseShellCommand(cmd);

    // Pipe remote script into shell (curl|sh, wget|bash, etc.)
    if (/\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|python|python3)\b/i.test(cmd)) {
        return "Piping remote download directly into a shell/interpreter";
    }

    // Critical shell/ssh/secret targets via shell command
    if (
        /(>>?\s*|tee\s+)(~\/|\$HOME\/)?(\.ssh\/|\.bashrc|\.zshrc|\.profile|\.bash_profile|\/etc\/(passwd|shadow|sudoers))/i.test(
            cmd
        )
    ) {
        return "Modifying sensitive ~/.ssh, shell rc, or /etc auth files";
    }
    if (
        !isAutoMode &&
        /(?:^|\s|\/)(\.env(?!\.(?:example|sample|template))|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.netrc)(?:\s|$)/i.test(
            cmd
        )
    ) {
        return "Accessing sensitive secret or credential files";
    }

    for (const seg of parsed.segments) {
        const { cmdTokens, usesSudo } = stripSegmentLead(seg);
        if (cmdTokens.length === 0) continue;
        const bin = path.basename(cmdTokens[0]);
        const argsList = cmdTokens.slice(1);

        if (bin === "dd" && argsList.some((a) => a.startsWith("of=/dev/"))) {
            return "Raw disk write via dd";
        }
        if (/^mkfs(\.|$)/.test(bin) || bin === "wipefs" || bin === "fdisk" || bin === "parted") {
            return `Filesystem/partition destructive tool (${bin})`;
        }
        if (bin === "chmod") {
            const hasRec = argsList.some((a) => /^-[a-zA-Z]*R/.test(a) || a === "--recursive");
            const has777 = argsList.some((a) => a === "777" || a === "0777" || a === "a+rwx");
            if (hasRec && has777) return "Recursive world-writable chmod 777";
        }
        if (bin === "git") {
            const isPush = argsList.includes("push");
            const isForce = argsList.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease");
            if (isPush && isForce) return "Force pushing git history (git push --force)";
        }
        if (!isAutoMode && usesSudo && ["apt", "apt-get", "dpkg", "yum", "dnf", "pacman", "snap"].includes(bin)) {
            if (
                argsList.some((a) =>
                    ["remove", "purge", "autoremove", "erase", "-r", "-P", "-R", "--remove", "--purge"].includes(a)
                )
            ) {
                return `Sudo package removal (${bin})`;
            }
        }
        if (bin === "rm") {
            const flags = argsList.filter((a) => a.startsWith("-")).join("");
            const recursive = flags.includes("r") || flags.includes("R") || argsList.includes("--recursive");
            const targets = argsList.filter((a) => !a.startsWith("-"));
            if (recursive) {
                for (const t of targets) {
                    if (["/", "/*", "~", "$HOME", "${HOME}", ".", "./", "..", "*"].includes(t)) {
                        return `Destructive recursive rm targeting '${t}'`;
                    }
                    const resolvedTarget = resolveRealWithMissingLeaf(
                        normalizeHomePath(path.resolve(workspaceRoot, t))
                    );
                    const resolvedRoot = resolveRealWithMissingLeaf(workspaceRoot);
                    if (resolvedTarget === "/" || resolvedTarget === os.homedir() || resolvedTarget === resolvedRoot) {
                        return `Destructive recursive rm targeting protected root '${resolvedTarget}'`;
                    }
                }
            }
        }
    }

    return null;
}

function globToRegex(pattern) {
    const clean = String(pattern || "").replace(/\\/g, "/");
    let re = "^";
    for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        const next = clean[i + 1];
        if (ch === "*" && next === "*") {
            re += ".*";
            i++;
            if (clean[i + 1] === "/") i++;
        } else if (ch === "*") {
            re += "[^/]*";
        } else if (ch === "?") {
            re += "[^/]";
        } else if (".+^${}()|[]\\".includes(ch)) {
            re += "\\" + ch;
        } else {
            re += ch;
        }
    }
    re += "$";
    return new RegExp(re);
}

function getUrlDomain(rawUrl) {
    try {
        return new URL(String(rawUrl || "")).hostname.toLowerCase();
    } catch {
        return "";
    }
}

function doesRuleMatchSegment(rule, segTokens, workspaceRoot) {
    if (rule.tool !== "run_command") return false;
    if (rule.scope === "tool") return true;
    if (rule.scope === "commandPrefix") {
        const { cmdTokens } = stripSegmentLead(segTokens);
        if (cmdTokens.length === 0) return false;
        const bin = path.basename(cmdTokens[0]);
        const normalizedCmd = [bin, ...cmdTokens.slice(1)].join(" ");
        const pat = rule.pattern.trim();
        return normalizedCmd === pat || normalizedCmd.startsWith(pat + " ");
    }
    return false;
}

function doesRuleMatchTool(rule, toolName, args, workspaceRoot) {
    if (rule.tool !== toolName && rule.tool !== "*") return false;
    if (rule.scope === "tool") return true;
    if (rule.scope === "path") {
        const paths = extractToolPaths(toolName, args, workspaceRoot);
        if (paths.length === 0) return false;
        const matcher = globToRegex(rule.pattern);
        return paths.every((absPath) => {
            const rel = path.relative(workspaceRoot, absPath).replace(/\\/g, "/");
            const normAbs = absPath.replace(/\\/g, "/");
            return matcher.test(rel) || matcher.test(normAbs);
        });
    }
    if (rule.scope === "domain") {
        const domain = getUrlDomain(args?.url);
        if (!domain) return false;
        const pat = rule.pattern.toLowerCase();
        if (pat.startsWith("*.")) {
            const rootDom = pat.slice(2);
            return domain === rootDom || domain.endsWith("." + rootDom);
        }
        return domain === pat;
    }
    return false;
}

function pickHighestPrecedence(matches) {
    if (!matches || matches.length === 0) return null;
    const deny = matches.find((r) => r.action === "deny");
    if (deny) return deny;
    const ask = matches.find((r) => r.action === "ask");
    if (ask) return ask;
    return matches.find((r) => r.action === "allow") || null;
}

function matchTierRules(rules, toolName, args, workspaceRoot) {
    if (toolName === "run_command") {
        const parsed = parseShellCommand(args?.command || "");
        if (parsed.segments.length === 0) return null;

        // First check if ANY rule denies/asks on ANY segment
        const segMatchesPerSeg = parsed.segments.map((seg) =>
            rules.filter((r) => doesRuleMatchSegment(r, seg, workspaceRoot))
        );
        const flat = segMatchesPerSeg.flat();
        const denyOrAsk = flat.find((r) => r.action === "deny") || flat.find((r) => r.action === "ask");
        if (denyOrAsk) return denyOrAsk;

        // To allow a compound command, never permit hidden subshells or output redirects by a simple prefix rule,
        // and EVERY segment must be individually covered by an allow rule!
        const allAllowed =
            !parsed.hasSubshell &&
            !parsed.hasRedirect &&
            segMatchesPerSeg.every((segRules) => segRules.some((r) => r.action === "allow"));
        if (allAllowed) {
            return segMatchesPerSeg.map((sr) => sr.find((r) => r.action === "allow"))[0];
        }
        return null;
    }

    const matches = rules.filter((r) => doesRuleMatchTool(r, toolName, args, workspaceRoot));
    return pickHighestPrecedence(matches);
}

/**
 * Evaluate exact tool execution decision: allow | ask | block.
 */
function evaluatePermission({
    toolName,
    args = {},
    settings = {},
    workspaceRoot = process.cwd(),
    extraDirs = [],
    sessionRules = [],
    paths = resolvePaths({ cwd: workspaceRoot }),
}) {
    const agentMode = settings.agentMode || "default";
    const toolPermission = settings.toolPermission || "ask";
    const nonWorkspaceAccess = settings.nonWorkspaceAccess || "ask";
    const isAutoMode = agentMode === "auto" || toolPermission === "always-proceed";
    const isAcceptEditsMode = agentMode === "accept-edits" || toolPermission === "allow-edits";

    // 1. Plan mode enforcement (code-level, cannot be bypassed by auto or rules)
    if (agentMode === "plan") {
        if (PLAN_BLOCKED_TOOLS.has(toolName)) {
            return {
                decision: "block",
                reason: "Plan mode: mutation blocked. Finish the plan and ask the user to approve.",
                risk: "BLOCKED",
            };
        }
        if (toolName === "run_command" && !isReadOnlyShellCommand(args?.command || "")) {
            return {
                decision: "block",
                reason: "Plan mode: only read-only commands are allowed. Finish the plan and ask the user to approve.",
                risk: "BLOCKED",
            };
        }
    }

    // 2. Explicit deny rules always block immediately (precedence: deny > ask > allow)
    const projectRules = loadPermissionRules("project", paths);
    const globalRules = loadPermissionRules("global", paths);
    const tiers = [
        { origin: "session", rules: Array.isArray(sessionRules) ? sessionRules : [] },
        { origin: "project", rules: projectRules },
        { origin: "global", rules: globalRules },
    ];
    let firstTierMatch = null;
    for (const tier of tiers) {
        if (!tier.rules.length) continue;
        const matched = matchTierRules(tier.rules, toolName, args, workspaceRoot);
        if (matched) {
            if (matched.action === "deny") {
                return {
                    decision: "block",
                    matchedRule: { ...matched, origin: tier.origin },
                    reason: `Blocked by ${tier.origin} rule (${matched.tool}:${matched.pattern || "*"})`,
                    risk: "BLOCKED",
                };
            }
            if (!firstTierMatch) {
                firstTierMatch = { origin: tier.origin, matched };
            }
        }
    }

    // 3. Catastrophic hard denylist asks even in auto mode
    const hardReason = checkHardDenylist(toolName, args, workspaceRoot, isAutoMode);
    if (hardReason) {
        return {
            decision: "ask",
            hardDenied: true,
            reason: `Hard denylist: ${hardReason}`,
            risk: "CRITICAL",
        };
    }

    // 4. Sudo: in 'auto' mode, auto-allow (password is requested at most once per session by runWithSudo);
    // in 'default' and 'accept-edits' modes, confirm the sudo command.
    if (toolName === "run_command" && !isAutoMode) {
        const parsed = parseShellCommand(args?.command || "");
        const hasSudo = parsed.segments.some((seg) => stripSegmentLead(seg).usesSudo);
        if (hasSudo) {
            return {
                decision: "ask",
                requiresSudo: true,
                reason: "sudo command requires confirmation",
                risk: "HIGH",
            };
        }
    }

    // 5. Non-workspace boundary check (in 'auto' mode, allowed automatically unless explicitly set to 'deny')
    if (FILE_PATH_TOOLS.has(toolName)) {
        const targetPaths = extractToolPaths(toolName, args, workspaceRoot);
        const outside = targetPaths.find((p) => !isPathInsideWorkspace(p, workspaceRoot, extraDirs));
        if (outside) {
            if (nonWorkspaceAccess === "deny") {
                return {
                    decision: "block",
                    reason: `Non-workspace access denied by policy: ${outside}`,
                    risk: "HIGH",
                };
            }
            if (nonWorkspaceAccess === "ask" && !isAutoMode) {
                return {
                    decision: "ask",
                    nonWorkspace: true,
                    reason: `Path outside workspace: ${outside}`,
                    risk: "HIGH",
                };
            }
        }
    }

    // 6. Tier ask / allow rules (session -> project -> global)
    if (firstTierMatch) {
        const { origin, matched } = firstTierMatch;
        if (matched.action === "ask" && !isAutoMode) {
            return {
                decision: "ask",
                matchedRule: { ...matched, origin },
                reason: `Rule requires confirmation (${matched.tool})`,
                risk: "MEDIUM",
            };
        }
        return {
            decision: "allow",
            matchedRule: { ...matched, origin },
            ruleLabel: `${origin} ${matched.scope}=${matched.pattern || matched.tool}`,
            risk: "LOW",
        };
    }

    // 7. Mode and preset policies
    const isReadOnlyCmd = toolName === "run_command" && isReadOnlyShellCommand(args?.command || "");
    const isRead = READ_TOOLS.has(toolName) || isReadOnlyCmd;

    if (isAutoMode) {
        return { decision: "allow", risk: isRead ? "LOW" : "MEDIUM" };
    }

    if (READ_TOOLS.has(toolName) || toolName === "web_fetch" || toolName === "save_session_memory") {
        return { decision: "allow", risk: "LOW" };
    }

    if (isAcceptEditsMode && (FILE_EDIT_TOOLS.has(toolName) || isReadOnlyCmd)) {
        return { decision: "allow", risk: isReadOnlyCmd ? "LOW" : "MEDIUM" };
    }

    if (isReadOnlyCmd && (agentMode === "plan" || toolPermission === "allow-reads")) {
        return { decision: "allow", risk: "LOW" };
    }

    return {
        decision: "ask",
        reason: `${toolName} requires confirmation in '${agentMode}' mode`,
        risk: toolName === "delete_file" || toolName === "run_command" ? "HIGH" : "MEDIUM",
    };
}

/**
 * Compute default narrowest rule suggestion for [s]/[A] approval scopes.
 */
function buildSuggestedRules(toolName, args = {}, workspaceRoot = process.cwd()) {
    const suggestions = [];
    if (toolName === "run_command") {
        const parsed = parseShellCommand(args?.command || "");
        const prefixes = Array.from(new Set(parsed.segments.map(getSegmentPrefix).filter(Boolean)));
        if (prefixes.length === 1 && !parsed.hasSubshell && !parsed.hasRedirect) {
            suggestions.push({
                label: `command prefix '${prefixes[0]}'`,
                rule: { action: "allow", tool: "run_command", scope: "commandPrefix", pattern: prefixes[0] },
            });
        }
        suggestions.push({
            label: `all run_command calls`,
            rule: { action: "allow", tool: "run_command", scope: "tool", pattern: "" },
        });
        return suggestions;
    }

    if (FILE_PATH_TOOLS.has(toolName)) {
        const target = args?.path || args?.file || args?.destination;
        if (target) {
            const abs = path.resolve(workspaceRoot, String(target));
            const relDir = path.relative(workspaceRoot, path.dirname(abs)).replace(/\\/g, "/");
            const dirGlob =
                relDir && !relDir.startsWith("..")
                    ? `${relDir}/**`
                    : path.relative(workspaceRoot, abs).replace(/\\/g, "/") || abs;
            suggestions.push({
                label: `path '${dirGlob}' for ${toolName}`,
                rule: { action: "allow", tool: toolName, scope: "path", pattern: dirGlob },
            });
        }
    }

    if (toolName === "web_fetch" || toolName === "download_file") {
        const domain = getUrlDomain(args?.url);
        if (domain) {
            suggestions.push({
                label: `domain '${domain}' for ${toolName}`,
                rule: { action: "allow", tool: toolName, scope: "domain", pattern: domain },
            });
        }
    }

    suggestions.push({
        label: `tool '${toolName}'`,
        rule: { action: "allow", tool: toolName, scope: "tool", pattern: "" },
    });
    return suggestions;
}

module.exports = {
    READ_TOOLS,
    NETWORK_READ_TOOLS,
    FILE_EDIT_TOOLS,
    FILE_PATH_TOOLS,
    MEMORY_WRITE_TOOLS,
    PLAN_BLOCKED_TOOLS,
    parseShellCommand,
    getSegmentPrefix,
    isReadOnlyShellCommand,
    isPathInsideWorkspace,
    resolveRealWithMissingLeaf,
    isProtectedConfigPath,
    isSecretFilePath,
    checkHardDenylist,
    evaluatePermission,
    buildSuggestedRules,
};
