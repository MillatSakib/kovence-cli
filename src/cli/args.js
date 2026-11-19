"use strict";

const path = require("node:path");
const { AGENT_MODES } = require("../settings/schema");

/**
 * Parse CLI flags strictly, rejecting unknown flags, missing option values, and invalid numbers.
 */
function parseArgs(argv) {
    const opts = {
        model: "",
        provider: "",
        prompt: "",
        system: "",
        mode: "",
        autoApprove: null,
        toolsEnabled: null,
        autoSummarize: null,
        temperature: null,
        maxTokens: null,
        session: "",
        newSession: "",
        continueLatest: false,
        addDirs: [],
        plain: false,
        json: false,
        noSession: false,
        debug: false,
        doctor: false,
        help: false,
        version: false,
    };
    const positional = [];

    const takeValue = (i, flag) => {
        if (i + 1 >= argv.length) {
            throw new Error(`Option '${flag}' requires a value.`);
        }
        return argv[i + 1];
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--") {
            positional.push(...argv.slice(i + 1));
            break;
        }
        if (a === "-h" || a === "--help") opts.help = true;
        else if (a === "-v" || a === "--version") opts.version = true;
        else if (a === "-a" || a === "--auto") opts.autoApprove = true;
        else if (a === "--no-tools") opts.toolsEnabled = false;
        else if (a === "--no-summary") opts.autoSummarize = false;
        else if (a === "--plain") opts.plain = true;
        else if (a === "--json") opts.json = true;
        else if (a === "--no-session") opts.noSession = true;
        else if (a === "--debug") opts.debug = true;
        else if (a === "-c" || a === "--continue") opts.continueLatest = true;
        else if (a === "-m" || a === "--model") {
            opts.model = takeValue(i, a);
            i++;
        } else if (a === "--provider") {
            opts.provider = takeValue(i, a);
            i++;
        } else if (a === "-p" || a === "--prompt") {
            opts.prompt = takeValue(i, a);
            i++;
        } else if (a === "-s" || a === "--system") {
            opts.system = takeValue(i, a);
            i++;
        } else if (a === "--mode") {
            const val = takeValue(i, a);
            i++;
            if (!AGENT_MODES.includes(val)) {
                throw new Error(`Invalid --mode '${val}'. Valid modes: ${AGENT_MODES.join(", ")}.`);
            }
            opts.mode = val;
        } else if (a === "--add-dir") {
            const dir = takeValue(i, a);
            i++;
            opts.addDirs.push(path.resolve(process.cwd(), dir));
        } else if (a === "-t" || a === "--temp") {
            const raw = takeValue(i, a);
            i++;
            const num = Number(raw);
            if (!Number.isFinite(num) || num < 0 || num > 2) {
                throw new Error(`Invalid temperature '${raw}'. Expected 0.0 to 2.0.`);
            }
            opts.temperature = num;
        } else if (a === "--max-tokens") {
            const raw = takeValue(i, a);
            i++;
            const num = Number.parseInt(raw, 10);
            if (!/^\d+$/.test(raw) || num < 1) {
                throw new Error(`Invalid --max-tokens '${raw}'. Expected positive integer.`);
            }
            opts.maxTokens = num;
        } else if (a === "--session") {
            opts.session = takeValue(i, a);
            i++;
        } else if (a === "--new-session") {
            opts.newSession = takeValue(i, a);
            i++;
        } else if (a.startsWith("-")) {
            throw new Error(`Unknown option '${a}'. Run with --help to see supported flags.`);
        } else {
            positional.push(a);
        }
    }
    if (positional[0] === "doctor" && !opts.prompt) {
        opts.doctor = true;
        positional.shift();
    }
    if (!opts.prompt && positional.length) opts.prompt = positional.join(" ");
    return opts;
}

function getHelpText() {
    return `Kovence CLI (https://kovence.com)
Usage: kovence [options] [prompt]  (or: kovence-cli / node nd.js)

CLI Options:
  --provider <name>        Use configured OpenAI/Anthropic provider
  -m, --model <name>       Override model (CLI > session > settings > provider)
  -p, --prompt <text>      Non-interactive prompt (clean answer on stdout)
  -s, --system <text>      Override system prompt
  --mode <mode>            Agent mode: default | accept-edits | plan | auto
  -a, --auto               Alias for --mode auto
  --add-dir <path>         Grant workspace access to an extra directory (repeatable)
  --no-tools               Disable tool calling (chat only)
  --no-summary             Skip post-response session memory summarization
  --plain                  Use plain scrollback REPL instead of full-screen TUI
  --json                   Emit structured JSON result in -p headless mode
  --no-session             Run without persisting session history to disk
  --debug                  Enable verbose debug tracing
  doctor                   Run environment, tools & provider connectivity checks
  -t, --temp <num>         Sampling temperature (0.0-2.0)
  --max-tokens <num>       Max completion tokens
  --session <name>         Resume/use a specific saved session
  -c, --continue           Resume the most recent session
  --new-session <name>     Start a fresh session with given name (default: auto new session)
  -v, --version            Show version
  -h, --help               Show help

Harness Commands:
  /help                    Show all commands
  /mode [mode]             Open mode picker or switch (default|accept-edits|plan|auto)
  /settings                Open interactive Settings panel (Ctrl+,)
  /set <key> <value>       Update persisted setting directly
  /api [subcmd]            Open provider picker or list/add/use/rm
  /model [name]            Open model picker or switch & save model
  /sessions [subcmd]       Open session picker (Ctrl+S) or list/new/switch/delete
  /new [name]              Create fresh isolated session (Ctrl+N)
  /save <name>             Rename and save current session
  /undo                    Rollback the last file edit/write/delete checkpoint
  /init                    Generate KOVENCE.md project guide
  /retry                   Retry the last failed or aborted prompt
  /history [n]             Show last n messages from session history
  /memory [subcmd]         Inspect/manage session & global memory
  /todos                   Show session task checklist
  /compact                 Compact older turns into session summary memory
  /stats                   Show context size, TTFT, generation speed & token usage
  /copy                    Copy last AI response (Ctrl+Y)
  /select                  Toggle native terminal selection (F2)
  /clear                   Clear current session history
  /exit                    Quit Kovence CLI`;
}

module.exports = {
    parseArgs,
    getHelpText,
};
