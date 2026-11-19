# Kovence CLI

> **Zero-dependency, multi-step AI coding-agent CLI for Node.js ≥ 20.12**

[![npm version](https://img.shields.io/npm/v/kovence-cli.svg)](https://www.npmjs.com/package/kovence-cli)
[![npm downloads](https://img.shields.io/npm/dm/kovence-cli.svg)](https://www.npmjs.com/package/kovence-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥ 20.12](https://img.shields.io/badge/node-%3E%3D20.12-brightgreen)](https://nodejs.org)

Kovence CLI is a powerful, **fully autonomous** AI coding-agent that runs entirely in your terminal. It supports any OpenAI-compatible or Anthropic endpoint, has zero runtime npm dependencies, and ships with a full-screen TUI, session management, background tasks, file checkpoints, and undo.

**Homepage:** <https://kovence-cli.kovence.com>

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Provider Setup](#provider-setup)
- [Agent Modes](#agent-modes)
- [CLI Flags](#cli-flags)
- [Slash Commands](#slash-commands)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [File Mentions (@file)](#file-mentions-file)
- [Background Tasks](#background-tasks)
- [Session Management](#session-management)
- [Settings Reference](#settings-reference)
- [Environment Diagnostics](#environment-diagnostics)
- [License](#license)

---

## Installation

### Global install (recommended)

```bash
npm install -g kovence-cli
```

After install, the `kovence` command is available system-wide:

```bash
kovence          # Launch interactive TUI
kovence --help   # Show help
kovence doctor   # Run diagnostics
```

### Try without installing

```bash
npx kovence-cli@latest
```

### From source

```bash
git clone https://github.com/kovence/kovence-cli.git
cd kovence-cli
npm install -g .
```

---

## Quick Start

1. **Launch the TUI:**
   ```bash
   kovence
   ```

2. **Add an AI provider** — on first launch there is no default provider. Add one with:
   ```
   /api add
   ```
   Or open **Models → + Add Custom Provider** inside the TUI.

3. **Start chatting** — type your message and press `Enter`. The agent will plan, call tools, and iterate autonomously.

4. **Switch modes** with `Shift+Tab` or `/mode`:
   - `plan` → read-only research
   - `auto` → fully autonomous, no approval prompts

---

## Provider Setup

Kovence supports any **OpenAI-compatible** endpoint and **Anthropic** natively.

### Interactive wizard

```
/api add
```

This opens a step-by-step wizard to enter your base URL, API key, and models. Providers are saved to `~/.config/kovence/providers.json`.

### Secret hygiene with `apiKeyEnv`

Instead of storing your raw API key on disk, you can point to an environment variable:

```json
{
  "name": "openai",
  "type": "openai",
  "baseURL": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

Kovence will read the key from your shell environment at runtime — it is never written to the config file.

### Popular endpoints

| Provider | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| Anthropic | _(select "anthropic" type)_ |
| Groq | `https://api.groq.com/openai/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| LiteLLM proxy | `http://localhost:4000` |

---

## Agent Modes

Switch modes with `/mode` or `Shift+Tab`:

| Mode | Behavior |
|---|---|
| `default` | Confirms file edits, downloads, and shell commands per policy |
| `accept-edits` | Auto-approves workspace file edits; confirms commands and downloads |
| `plan` | Read-only research & planning; all mutating tools are blocked |
| `auto` | **Fully autonomous** — no approval prompts for any tool call |

> **Auto mode** is designed for truly autonomous operation. The agent never asks for tool approval. Safety comes from the permission engine, audit log, file checkpoints, and undo — not from prompts.

---

## CLI Flags

```
kovence [options] [prompt]
kovence doctor
```

| Flag | Description |
|---|---|
| `--provider <name>` | Use a configured provider by name |
| `-m, --model <name>` | Override the active model |
| `-p, --prompt <text>` | Non-interactive headless prompt (exits when done) |
| `-s, --system <text>` | Override the system prompt |
| `--mode <mode>` | Agent mode: `default \| accept-edits \| plan \| auto` |
| `-a, --auto` | Alias for `--mode auto` |
| `--add-dir <path>` | Grant workspace access to an extra directory (repeatable) |
| `--no-tools` | Disable all tool calling (chat-only mode) |
| `--no-summary` | Skip post-response session memory summarization |
| `--plain` | Use plain scrollback REPL instead of full-screen TUI |
| `--json` | Emit structured JSON result in `-p` headless mode |
| `--no-session` | Run without persisting session history to disk |
| `--debug` | Enable verbose debug tracing |
| `-t, --temp <num>` | Sampling temperature (`0.0` to `2.0`) |
| `--max-tokens <num>` | Max completion tokens |
| `--session <name>` | Resume or create a specific named session |
| `-c, --continue` | Resume the most recent session |
| `--new-session <name>` | Start a fresh session with the given name |
| `-v, --version` | Show version and exit |
| `-h, --help` | Show help and exit |
| `doctor` | Subcommand: check Node, tools, config, and provider reachability |

### Headless / scripting example

```bash
# Single-shot prompt, structured JSON output
kovence -p "summarize this file" --json

# Pipe output
echo "refactor this function" | kovence --plain --no-session
```

---

## Slash Commands

Type `/` in the composer to see autocomplete suggestions.

| Command | Description |
|---|---|
| `/help` | Show all available commands |
| `/mode` | Switch agent mode (`default \| accept-edits \| plan \| auto`) |
| `/settings` | Open interactive Settings panel (`Ctrl+,`) |
| `/set <key> <val>` | Update a persisted setting directly |
| `/api` | Switch, add, or remove AI providers |
| `/model [name]` | Pick or switch the active model |
| `/sessions` | Session picker — list, switch, delete sessions (`Ctrl+S`) |
| `/new` | Open a new isolated session (`Ctrl+N`) |
| `/rename <name>` | Rename the current session |
| `/fork [name]` | Fork current session into a new branch |
| `/export [md\|json] [path]` | Export session transcript to a file |
| `/retry` | Retry the last failed or aborted turn |
| `/edit-last` | Pop the last turn and restore your prompt for editing |
| `/history` | Show session chat history |
| `/memory` | Show and manage session & global memory |
| `/todos` | Show current multi-step todo list |
| `/compact` | Compact history into a session summary |
| `/stats` | Show context size, speed, and token statistics |
| `/cost` | Show estimated session token cost in USD |
| `/copy` | Copy the last AI response to clipboard (`Ctrl+Y`) |
| `/select` | Toggle native terminal mouse-select mode (`F2`) |
| `/save` | Save/rename the current session |
| `/undo` | Roll back the last file edit/write/delete checkpoint |
| `/init` | Scan project and generate `KOVENCE.md` instructions |
| `/tasks [log <id> \| kill <id>]` | List, view logs, or stop background shell tasks |
| `/clear` | Clear current session history and memory |
| `/exit` | Exit Kovence CLI |

---

## Keyboard Shortcuts

### Composer (input area)

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` / `Alt+Enter` | Insert newline |
| `Tab` | Accept autocomplete suggestion (slash command / `@file`) |
| `↑` / `↓` | Scroll through input history or suggestions |
| `Ctrl+Left` / `Alt+B` | Move cursor one word left |
| `Ctrl+Right` / `Alt+F` | Move cursor one word right |
| `Ctrl+W` / `Alt+Backspace` | Delete word to the left |
| `Ctrl+C` _(busy)_ | Cancel the current agent turn |
| `Ctrl+C` _(idle)_ | Exit Kovence CLI |

### TUI global shortcuts

| Key | Action |
|---|---|
| `Ctrl+,` | Open Settings panel |
| `Ctrl+S` | Open session picker |
| `Ctrl+N` | Start a new session |
| `Ctrl+Y` | Copy last AI response to clipboard |
| `Ctrl+L` | Clear and redraw the screen |
| `Ctrl+O` | Toggle last collapsible block (tool output) |
| `Shift+Tab` | Cycle agent mode |
| `F2` | Toggle mouse-select mode |

---

## File Mentions (@file)

You can mention files directly in your prompt using the `@` syntax. Kovence will read the file content and include it in context.

```
@README.md what does this say about installation?

@src/agent/turn.js:L1-80 explain this section
```

- `@filename` — include the entire file
- `@filename:L10-50` — include only lines 10–50

Autocomplete is available: type `@` and press `Tab` to browse files.

---

## Background Tasks

### Direct shell escape

In plain REPL mode, prefix a command with `!` to run it directly in your shell:

```
!git status
!npm test
```

### Agent background tasks

The agent can run shell commands as background tasks (`run_command` with `background: true`). Manage them with:

```
/tasks              # List all running background tasks
/tasks log <id>     # Stream logs from a task
/tasks kill <id>    # Terminate a background task
```

Background tasks persist across turns and are shown in the status bar when active.

---

## Session Management

### Auto-naming

Sessions are automatically named from your first prompt (slugified, e.g., `fix-auth-bug`). You can rename anytime:

```
/rename my-feature-branch
```

### Date grouping

The session picker (`Ctrl+S`) groups sessions by date (Today, Yesterday, This Week, etc.) for easy navigation.

### Fork & Export

```
/fork               # Fork into a new session (preserves history)
/fork my-fork-name  # Fork with a specific name

/export md          # Export transcript as Markdown
/export json        # Export as JSON
/export md ~/Desktop/session.md   # Export to a specific path
```

### Edit last turn

```
/edit-last   # Removes the last turn and restores your prompt for editing
```

### Undo file changes

```
/undo   # Roll back the last file write/edit/delete (checkpoint-based)
```

---

## Settings Reference

Open the interactive settings panel with `Ctrl+,` or `/settings`. Settings are saved to `~/.config/kovence/settings.json`.

| Setting | Values | Description |
|---|---|---|
| `agentMode` | `default \| accept-edits \| plan \| auto` | Default agent mode on launch |
| `toolPermission` | `default \| auto` | Tool permission policy |
| `nonWorkspaceAccess` | `true \| false` | Allow reads outside workspace |
| `model` | string | Default model name |
| `provider` | string | Default provider name |
| `toolsEnabled` | `true \| false` | Enable/disable tool calling |
| `autoSummarize` | `true \| false` | Auto-compact history when context is full |
| `maxToolSteps` | number | Max tool-call iterations per turn |
| `maxHistoryMessages` | number | Max messages kept in context |
| `contextWindow` | number | Context window size (tokens) |
| `temperature` | `0.0`–`2.0` | Sampling temperature |
| `maxTokens` | number | Max completion tokens |
| `verbosity` | `low \| normal \| high` | Tool output verbosity in TUI |
| `language` | `english \| banglish \| bangla` | Preferred response language |
| `renderingMode` | `fullscreen \| inline` | TUI layout mode |
| `queuedMessages` | `queue \| interrupt` | Behavior when a message arrives during a turn |
| `showTips` | `true \| false` | Show contextual tips in TUI |
| `showActiveTasks` | `true \| false` | Show background task count in status bar |
| `notifications` | `true \| false` | Desktop notifications on turn completion |
| `colorScheme` | `amber \| dark \| light \| terminal` | TUI color theme |

You can also set any value directly:

```bash
# In the TUI composer:
/set agentMode auto
/set colorScheme dark
/set temperature 0.7
```

---

## Environment Diagnostics

```bash
kovence doctor
```

Checks and reports on:
- Node.js version compatibility
- Required system tools (`git`, `curl`, etc.)
- Config and provider file validity
- Provider API reachability (live ping)

---

## License

MIT © Kovence
