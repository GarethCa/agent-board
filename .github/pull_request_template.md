<!-- markdownlint-disable-file MD041 -- GitHub pre-fills the PR body with this; the PR title is the heading. -->
<!-- Title: what the change does, e.g. "Keep expanded tiles apart". Branch: named after the change, e.g. fix-tile-overlap. -->

Fixes #

<!-- Finish the line above with the GitHub issue this closes, e.g. "Fixes #12", or delete it if there is none. Write every section for a reader who hasn't seen the issue. -->

## Problem

<!-- What is wrong or missing, who it affects, and why it matters. For a bug: what happens, when, and the cause once known. -->

## Change

<!-- What this PR does about it, in a sentence or two. -->

## How it's implemented

<!-- The approach and the key pieces: which modules, data or migrations, and UI changed, and how they fit together. Decisions, trade-offs and anything deliberately left out. -->

## How to verify

<!-- Commands to run or steps to follow in the app. Screenshots or a recording for UI changes. -->

## Checklist

- [ ] Tests written first, and they test behaviour, not internals
- [ ] No test calls the real `claude` or `codex` (use `packages/fake-harness`)
- [ ] `pnpm check:pr` passes on the head commit (it runs the full `pnpm check:local` when the gate, shared config, helpers, fakes or protocol change), and its table is under "How to verify"
- [ ] README, `CONTEXT.md` and ADRs updated if this changes a command, a domain term or a decision
