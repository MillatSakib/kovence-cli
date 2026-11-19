# Contributing to kovence-cli

Thank you for contributing to `kovence-cli`!

## Requirements

- Node.js `>= 20.12.0`
- Zero runtime npm dependencies (`dependencies` in `package.json` must remain empty; dev-only tooling belongs in `devDependencies`).

## Development Workflow

```bash
npm install
npm run check
npm test
```

## Guidelines

- Follow CommonJS (`"use strict";`).
- Keep changes focused and add unit tests under `test/` using `node:test` and `node:assert/strict`.
- Never commit `.env`, `.kovence/`, `.ai_harness/`, or API credentials.
