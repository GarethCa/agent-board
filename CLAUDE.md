# agent-board

Desktop app that shows Claude Code and Codex sessions as objects on an infinite board. The domain glossary is `CONTEXT.md`; decisions are in `docs/adr/`. How to contribute is in `CONTRIBUTING.md`.

## Working rules

- Never push to `main` or force-push. All changes land through a pull request.
- Name branches, commits and pull requests after the change, not after a tracker ID: branch `fix-tile-overlap`, PR `Keep expanded tiles apart`. Reference a GitHub issue as `#12` in the PR body (`Fixes #12`) when there is one.
- Write the test first. Test behaviour through public interfaces: the daemon's JSON-RPC API and the app's UI.
- Tests must never spend tokens: use the fake `claude`/`codex` binaries in `packages/fake-harness`, never the real CLIs, in tests.
- Use the words in `CONTEXT.md` (zone, tile, session, harness, edge) in code, tests and PRs.
- If a change goes against an ADR, say so in the PR and update the ADR in the same PR.
- Before opening a PR, run `pnpm check:pr` and paste its table into the PR.
