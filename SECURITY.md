# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `kovence-cli`, please do **not** open a public issue with exploit details. Instead, report it privately to the maintainers with reproduction steps, affected versions, and impact assessment.

## Security Model Notes

- **API Keys**: Prefer storing API keys via `apiKeyEnv` (environment variable name) rather than plaintext in `~/.config/kovence/providers.json`. Provider config files are written with `0600` permissions.
- **Permission Modes**:
  - `default`, `accept-edits`, and `plan` enforce interactive confirmation and workspace boundaries for mutating actions.
  - `auto` mode is designed for autonomous execution without tool-approval prompts.
- **Sudo Handling**: Interactive `sudo` prompts use an ephemeral `SUDO_ASKPASS` helper (`0700` dir / `0600` script) cleaned up on exit.
