# Releasing Toolrator packages

Releases are **maintainer-driven**. Merging a PR into `main` never publishes
anything — code only reaches npm when a maintainer pushes a special
**release tag**. This keeps `main` a safe integration branch and gives every
published version a human sign-off.

## What is published where

| Package | npm name | Published via npm? |
|---|---|---|
| `packages/toolconnector` | `@toolrator/toolconnector` | ✅ yes (per-package tags) |
| `packages/toolpanel` | `@toolrator/toolpanel` | ✅ yes (per-package tags) |
| `packages/toolhub` | — | ❌ intentionally private (server-side service, not distributed via npm) |

## How releases work (the short version)

Each package is released **independently**, using a tag whose *name* says
which package to ship:

- tag `toolconnector-v0.0.2` → publishes **only** `@toolrator/toolconnector`
- tag `toolpanel-v0.1.1` → publishes **only** `@toolrator/toolpanel`

The publish robot (`.github/workflows/npm-publish.yml`) fires on those tags,
installs dependencies, typechecks + builds the package, and publishes it with
the version from that package's `package.json`.

> The tag suffix and the `package.json` version must match **exactly** — the
> workflow verifies this before publishing and fails the run if they disagree.
> Example: tag `toolconnector-v0.0.2` requires `packages/toolconnector/package.json`
> to have `"version": "0.0.2"`. Prerelease suffixes count: tag
> `toolconnector-v0.0.2-preview` requires version `0.0.2-preview`.

## Release checklist (per package)

1. Make sure `main` is green (CI passes on the latest commit).
2. Bump the version **from inside the package directory**, so both
   `package.json` **and** `package-lock.json` are updated together
   (`package-lock.json` is committed — do not hand-edit either file):

   ```bash
   cd packages/toolconnector        # or packages/toolpanel
   npm version 0.0.2 --no-git-tag-version
   ```

   Pick the number per semver:
   - bug fix → patch (`0.0.1` → `0.0.2`)
   - new feature → minor (`0.0.2` → `0.1.0`)
   - breaking change → major (stay `0.x` until the first stable `1.0.0`)

   Use the **full version, prerelease suffix included** (`0.0.2` or
   `0.0.2-preview`). Note that npm never lets you re-publish a version that
   already exists — a *new* preview needs a *new* number (e.g. the next
   preview after `0.0.1-preview` is `0.0.2-preview`, never `0.0.1-preview`
   again).
3. Refresh hardcoded version mentions of the old version in user-facing
   package docs (grep for the previous version):

   ```bash
   grep -rn "0.0.1-preview" README.md    # update Project Status / version prose
   ```

   `packages/toolconnector/README.md` hardcodes its version in the Project
   Status banner and the "In version …" tool-interface note.
4. Commit the bump: `chore(release): <name> v<version>`.
5. Create the tag — easiest through the GitHub UI:
   **Releases → Draft a new release** → tag name `<name>-v<version>` →
   target branch `main` → write 2–3 release notes lines → **Publish release**.

   The tag's version suffix must **exactly equal** the `package.json` version
   you bumped to (step 2) — the publish run fails otherwise.

   CLI equivalent: `git tag <name>-v<version> && git push origin <name>-v<version>`.
6. Open the **Actions** tab and watch the "Publish to NPM Registry" run
   finish green. Users can then `npx -y @toolrator/<name>` the new version.
7. Verify what is live:

   ```bash
   npm view @toolrator/<name> version
   ```

## Rules that keep releases safe

- **Never publish the same version twice.** npm rejects duplicates — if the
  workflow fails with "version already exists", you forgot to bump.
- **Never rewrite a published version.** Fix forward with a new one.
- Only maintainers can tag, so contributor PRs can never trigger a publish.

## Publishing authentication (OIDC Trusted Publishing)

Publishes authenticate via **GitHub OIDC Trusted Publishing** — there is no
`NPM_TOKEN` secret and no token fallback. Both packages have Trusted
Publishers configured on npmjs.com (org `toolrator`, repo `Toolrator`,
workflow `npm-publish.yml`), and both were validated end-to-end on
2026-09-18: `toolconnector@0.1.1` and `toolpanel@0.1.1` published green via
OIDC with SLSA provenance attestations. The old `NPM_TOKEN` secret was
deleted from the repo and the npm token revoked the same day.

If a publish ever fails auth, check the Trusted Publisher configuration on
npmjs.com (org, repo, and workflow file name must match) before anything
else — do **not** reintroduce a long-lived token as a "fix".

### Trusted Publisher gotcha (hit for real on 2026-09-18, toolconnector 0.2.0)

npm reports a Trusted Publisher auth failure as a **misleading `E404` on
`PUT https://registry.npmjs.org/<pkg>`** — even though provenance signing
via GitHub OIDC succeeds (watch for the "Signed provenance statement" notice
right before the error). That combination = the Trusted Publisher connection
rejected the publish; it is **not** a missing package and **not** a workflow
bug.

Fix, in order:

1. On npmjs.com → package → Settings → Trusted publishing, check the
   connection's **Allowed actions**: it must permit **`npm publish`** (not
   stage-only). The "Require two-factor authentication and disallow tokens"
   package setting is fine to keep — OIDC publishes are not bypass tokens —
   but flipping package-level security settings can silently desync the
   connection.
2. Connections **cannot be edited in place** — delete and re-create it
   (org `toolrator`, repo `Toolrator` — case-sensitive — workflow
   `npm-publish.yml`, environment empty, `npm publish` allowed).
3. Re-run the failed job from the Actions tab (job → "Re-run failed jobs")
   or re-push the tag. No new version or tag is needed for a rerun.

The first publish of each package claimed its name on npm. Verify what is
live with `npm view @toolrator/<name> version`.
