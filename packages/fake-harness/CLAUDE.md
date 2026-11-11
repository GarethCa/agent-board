# packages/fake-harness: code map

The fake `claude` and `codex` (`bin/`) every test runs instead of the real CLIs. `README.md` covers how to use them, their scenarios and their lifetime: read it before you write a test that starts an agent.

| What | Files |
|---|---|
| The entry points | `src/cli/claude.ts`, `src/cli/codex.ts`, `src/cli/run.ts`; `src/index.ts` exports what tests import (`fakeHarnessEnv`, `startHookRecorder`, …) |
| Each harness's behaviour | `claude.ts`, `codex.ts`, `session.ts`, `args.ts`, `toml.ts`, `mcp.ts` |
| Scripted runs | `scenarios.ts` (pick one with `FAKE_HARNESS_SCENARIO`), `demo-scenarios.ts`, `demo.ts` |
| Screens copied from the real TUIs | `trust-screen.ts`, `rate-limit-menu.ts`, `codex-screens.ts` |
| Hooks and what they send | `hooks.ts`, `recorder.ts`, `tool-output.ts`, `jsonl.ts` |
| Guards that keep tests off the real CLIs and the real board | `guard.ts`, `board-guard.ts`, `git-guard.ts`, `processes.ts`, `paths.ts` |

A new scenario goes in `scenarios.ts`, with a test in `test/`.
