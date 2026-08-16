# Contributing to Toolrator Open Source

Thank you for considering contributing! This document covers the workflow for the open-source packages (`toolconnector`, `toolhub`, `toolpanel`).

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/toolrator/toolrator.git
cd toolrator

# 2. Install dependencies (per package — no root install needed)
cd packages/toolconnector && npm install
cd ../toolhub && npm install
cd ../toolpanel && npm install

# 3. Run tests
cd packages/toolconnector && npm test
cd ../toolhub && npm test
```

## Development Conventions

- **TypeScript** — Strict mode, all packages.
- **Test runner** — Node.js built-in `node --test` (no Jest, no Vitest).
- **Package manager** — `npm` (not yarn, not pnpm).
- **Typecheck** — `npm run typecheck` per package.
- **Error classification** — Use `classifyUpstreamError()` in `packages/toolconnector/src/errors.ts`.

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes in the relevant package directory
3. Run tests: `npm test` in the affected package(s)
4. Run typecheck: `npm run typecheck` in the affected package(s)
5. Open a PR against the `main` branch

## Reporting Issues

- **Bug reports**: Open a GitHub issue with reproduction steps and package version.
- **Security vulnerabilities**: Email security@toolrator.com (do not open a public issue).

## Code of Conduct

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

---

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
