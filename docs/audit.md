# Kovence CLI Baseline Audit (Phase 0.1)

| Claim | Verified | Evidence |
|---|---|---|
| No MCP client or server support | Yes | `grep` across `nd.js`, `tools.js`, `providers.js`, `src/` returned 0 matches |
| No lifecycle hooks (`PreToolUse`, `PostToolUse`, etc.) | Yes | `grep` across `nd.js`, `tools.js`, `src/` returned 0 matches |
| No sub-agent delegation tool (`task` / `delegate`) | Yes | `grep` across `tools.js`, `src/` returned 0 matches |
| No OS sandbox (`bwrap` / `sandbox-exec`) for `run_command` | Yes | `tools.js:866-965` and `src/tools/exec.js:56` execute `bash` directly without sandbox wrappers |
| Git tools are read-only (`git_status`, `git_diff`, `git_log`) | Yes | `tools.js:363-395` and `tools.js:821-840` |
| No Anthropic `cache_control` prompt caching | Yes | `providers.js:218-232` omits `cache_control` markers |
| No verified tokenizer (heuristic estimate used) | Yes | `src/agent/history.js:6-17` (`estimateTextTokens` uses ASCII/non-ASCII char multipliers) |
| No structured JSONL logger | Yes | No rotating/structured logger under `src/` (`nd.js`, `src/agent/turn.js` write only to UI sinks) |
| No multimodal image input support | Yes | `grep` for `image_url` / vision blocks returned 0 matches (`base64` only in `tui.js:30` OSC 52 and `src/tools/checkpoints.js:46,84`) |
| No lint, format, CI, coverage, or type-check setup | Yes | `package.json:13-16` defines only `test` and `check`; no `.github/workflows/ci.yml`, `eslint`, `prettier`, or `tsconfig.json` |
| `README.md` and `CHANGELOG.md` listed in `package.json` `"files"` but missing | Yes | `package.json:25-26` vs root `ls -la` |
| No `LICENSE` file despite `"license": "MIT"` | Yes | `package.json:5` vs root `ls -la` |
| Repo junk (`*.AppImage`, `.Rhistory`, `.kovence/`, `.ai_harness/`) | Partial | `./.Rhistory`, `.kovence/`, `.ai_harness/` exist on disk; `*.AppImage` is not present in working tree (`find` returned 0) |
