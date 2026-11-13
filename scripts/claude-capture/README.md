# Claude Code start-up capture

Records what the **real** `claude` draws as it starts into `fixtures/claude/tui/`, so the tests read a new agent's screen as the real TUI draws it, not as the fake harness does. Run it by hand when Claude Code changes version; tests never run it.

It types nothing at Claude, so no prompt reaches the model and no tokens are spent. It starts Claude twice in a 100×30 PTY: once in a folder Claude has never seen (its trust screen), once in a folder its config already trusts (its empty prompt). It records each until the screen has been still for 4 seconds, then kills Claude. It keeps the time of each chunk, so the tests replay the screen at the pace Claude drew it; it warns if the screen never stayed still.

Always use a throwaway `CLAUDE_CONFIG_DIR`: `capture.py` refuses to run against `~/.claude`. It also refuses a work dir in your home, as Claude shows its folder. Sign in with a token in the environment (`claude setup-token` makes one), since a fresh config dir has no login of its own:

```sh
W=/tmp/cc; rm -rf $W; mkdir -p $W
export CLAUDE_CONFIG_DIR=$W/config CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>
python3 scripts/claude-capture/capture.py $W
```

It writes `startup-<version>.bin` (the prompt) and `startup-<version>-trust.bin`, each with a `.json` of the version, the terminal size, what it shows and its chunks' times. Your name (as the throwaway config, `git config user.name` and macOS's `id -F` give it, whole and word by word), your account's email and organisation, your user name and your home path are replaced with as many `x`s, so the screen keeps its layout. A recording that still holds an email address or the token is not saved, and nor is a prompt recording whose last `❯` isn't between two rules (a menu, not the empty input box). It prints each saved screen as text: read it.

Then check:

- The printed text holds nothing of yours, and `grep -rli -e "$USER" -e <your first name> -e <your last name> fixtures/claude/tui` finds nothing.
- `pnpm exec vitest run packages/daemon/test/recorded-startup-screens.test.ts` passes. If it fails, first check that the printed prompt screen really is Claude's empty input box. If it is, the app no longer recognises Claude's prompt or trust screen in this version: fix `packages/daemon/src/startup-screen.ts`, not the recording.

Afterwards, delete `$W`.
