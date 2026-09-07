# Contributing to Toolrator Open Source

Thank you for considering contributing! This document covers the workflow for the open-source packages (`toolconnector`, `toolhub`, `toolpanel`).

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/toolrator/Toolrator.git
cd Toolrator

# 2. Install dependencies — EITHER once at the root (npm workspaces):
npm install
# ...or per package, if you prefer isolated installs:
# cd packages/toolconnector && npm install
# cd ../toolhub && npm install
# cd ../toolpanel && npm install

# 3. Run tests
npm test            # runs every package's test suite via workspaces
# or a single package:
cd packages/toolconnector && npm test
```

## Development Conventions

- **TypeScript** — Strict mode, all packages.
- **Test runner** — Node.js built-in `node --test` (no Jest, no Vitest).
- **Package manager** — `npm` (not yarn, not pnpm).
- **Typecheck** — `npm run typecheck` per package.
- **Error classification** — Use `classifyUpstreamError()` in `packages/toolconnector/src/errors.ts`.

## Pull Request Process

1. Fork the repo and create a branch from `main` (the default branch)
2. Make your changes in the relevant package directory
3. Run tests: `npm test` in the affected package(s)
4. Run typecheck: `npm run typecheck` in the affected package(s)
5. Open a PR against the `main` branch

## Releases

Merging a PR into `main` does **not** publish anything to npm. Releases are cut
by maintainers with per-package tags (`toolconnector-vX.Y.Z`, `toolpanel-vX.Y.Z`)
— see [RELEASING.md](./RELEASING.md) for the exact process. CI enforces that
each tag's version matches that package's `package.json` version. As a contributor you
don't need to do anything for a release: your merged work ships automatically
with the next tagged release of that package.

## Reporting Issues

- **Bug reports**: Open a GitHub issue with reproduction steps and package version.
- **Security vulnerabilities**: Email security@toolrator.org (do not open a public issue).

## Code of Conduct

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

---

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
