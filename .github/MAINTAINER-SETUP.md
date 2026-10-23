# Maintainer setup for a contributor launch

The repository contains contributor instructions, a question path through blank issues, templates and package checks. Live GitHub settings still require a maintainer action; this document does not claim they have been enabled.

## Main-branch rules

Before applying protection, account for path-filtered workflows and scheduled baseline refreshes:

- Require pull requests for human changes; block force pushes and branch deletion.
- Require the relevant package typecheck/build/test checks and CodeQL. Check names must be unique and workflows required globally must run on every PR, including documentation-only PRs. Do not require a path-filtered workflow that will never report for some PRs.
- Keep an explicit audited maintainer/baseline-bot policy. The quality/performance refresh jobs currently create generated commits; enforcing required PRs on those jobs without changing their workflow will break them. Prefer baseline-update PRs when enabling strict protection.
- Choose reviewer requirements appropriate to the actual maintainer team. Requiring another reviewer on a one-maintainer project without a deliberate exception can prevent all merges.

These settings should be reviewed with the actual GitHub check contexts immediately before application. No ruleset or bypass has been applied by adding this file.

## Starter issues to publish

Draft three small `good first issue` tasks from the contribution directions in CONTRIBUTING.md:

1. **Document a clean macOS local setup.** Follow the README from a clean clone, use memory-mode search, connect the panel and verify a harmless tool call. Acceptance: commands, prerequisites, tested client versions and no credentials in the report.
2. **Add a copied-capability search fixture.** Supply a compact synthetic catalog with a useful owner endpoint and irrelevant repeated capabilities. Acceptance: expected top result and diverse tool cards, all package tests and search-quality eval pass without lowering baselines.
3. **Add a client compatibility report.** Document an additional MCP client and negotiated revision, with install/list/call evidence. Acceptance: a regression test for any new failure, or a reproducible compatibility report with secrets removed.

Open these only when the maintainer will respond. They are draft tasks here, not fabricated open GitHub issues. Confirm that security/conduct addresses are received and monitored before relying on those reporting promises. Questions do not require a nonexistent chat server or disabled Discussions.
