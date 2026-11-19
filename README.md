# Kovence CLI

Zero-dependency multi-step AI coding-agent CLI for Node.js (`>= 20.12.0`).

## Installation

```bash
npm install -g kovence-cli
```

Or run directly from the repository:

```bash
node nd.js --help
```

## Quick Start

1. Launch interactive TUI:
   ```bash
   kovence
   ```
2. Add your AI provider and models inside the CLI using `/api add` (or `/models` -> `+ Add Custom Provider`).
   - Supports **OpenAI-compatible** and **Anthropic** endpoints.
   - For better secret hygiene, use `apiKeyEnv` (e.g. `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) so the raw key is resolved from your environment instead of written to `~/.config/kovence/providers.json`.
3. Run diagnostics anytime:
   ```bash
   kovence doctor
   ```

## Permission Modes

Switch modes with `/mode` or `Shift+Tab`:

| Mode | Behavior |
|---|---|
| `default` | Confirms file edits, downloads, and shell commands per policy |
| `accept-edits` | Auto-approves workspace file edits; confirms commands and downloads |
| `plan` | Read-only research & planning mode; all mutating tools and non-readonly commands blocked |
| `auto` | Autonomous execution without tool-approval prompts |

## CLI Flags

| Flag | Description |
|---|---|
| `--provider <name>` | Use configured OpenAI/Anthropic provider |
| `-m, --model <name>` | Override active model |
| `-p, --prompt <text>` | Non-interactive headless prompt |
| `-s, --system <text>` | Override system prompt |
| `--mode <mode>` | Agent mode: `default \| accept-edits \| plan \| auto` |
| `-a, --auto` | Alias for `--mode auto` |
| `--add-dir <path>` | Grant workspace access to an extra directory (repeatable) |
| `--no-tools` | Disable tool calling (chat only) |
| `--no-summary` | Skip post-response session memory summarization |
| `--plain` | Use plain scrollback REPL instead of full-screen TUI |
| `--json` | Emit structured JSON result in `-p` headless mode |
| `--no-session` | Run without persisting session history to disk |
| `--debug` | Enable verbose debug tracing |
| `-t, --temp <num>` | Sampling temperature (`0.0` to `2.0`) |
| `--max-tokens <num>` | Max completion tokens |
| `--session <name>` | Resume/use a specific saved session |
| `-c, --continue` | Resume the most recent session |
| `--new-session <name>` | Start a fresh session with given name |
| `-v, --version` | Show version |
| `-h, --help` | Show help |
| `doctor` | Subcommand: check Node, tools, config, and provider reachability |

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/mode` | Switch agent mode (`default\|accept-edits\|plan\|auto`) |
| `/settings` | Open interactive Settings panel (`Ctrl+,`) |
| `/set` | Update persisted setting (`/set <key> <val>`) |
| `/api` | Switch/add OpenAI or Anthropic custom APIs |
| `/model` | Pick or switch active model (`/model [name]`) |
| `/sessions` | Session picker / manage (`list\|new\|switch\|delete`) (`Ctrl+S`) |
| `/new` | Open a new isolated session (`Ctrl+N`) |
| `/retry` | Retry the last failed/aborted user turn |
| `/history` | Show session chat history |
| `/memory` | Show/manage session & global memory |
| `/todos` | Show current session multi-step todos |
| `/compact` | Compact history into session summary |
| `/stats` | Show full context size, speed & token stats |
| `/copy` | Copy last AI response to clipboard (`Ctrl+Y`) |
| `/select` | Toggle native terminal mouse select mode (`F2`) |
| `/save` | Rename/save current session |
| `/rename` | Rename current session |
| `/fork` | Fork current session into a new branch |
| `/export` | Export session transcript (`md\|json`) |
| `/edit-last` | Pop last turn and restore prompt for editing |
| `/undo` | Rollback the last file edit/write/delete checkpoint |
| `/init` | Scan project & generate `KOVENCE.md` instructions |
| `/tasks` | List, view logs, or stop background shell tasks |
| `/cost` | Show estimated session token cost in USD |
| `/clear` | Clear current session history & memory |
| `/exit` | Exit Kovence CLI |

## License

MIT
