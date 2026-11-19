# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-19

### Added
- Zero-dependency multi-step AI coding-agent CLI (`kovence` / `kovence-cli`).
- Support for OpenAI-compatible and Anthropic API providers with retry/backoff, custom provider wizard (`/api add`), and `apiKeyEnv` isolation.
- Interactive full-screen TUI (`KovenceTUI`) with amber/dark/light/terminal themes, `@file` fuzzy picker, `@file:L10-50` line ranges, `!cmd` shell escape, and persistent input history.
- Permission engine with `default`, `accept-edits`, `plan`, and `auto` modes, plus interactive `Manage Permissions` panel inside `/settings`.
- Ephemeral `SUDO_ASKPASS` handling, resumable Range downloads with SHA-256 verification, file checkpoints with `/undo`, background tasks (`/tasks`), and `kovence doctor`.
