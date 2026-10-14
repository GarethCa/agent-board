# Codex hook capture

Re-captures `fixtures/codex/` from the **real** `codex` CLI. This spends real tokens, so it's never run by tests. Run it by hand when Codex changes version (the spike captured `0.162.0-alpha.2`).

Always use a throwaway `CODEX_HOME`; `capture.py` refuses to run against `~/.codex`. Copy `auth.json` in (copy it, don't symlink it, so nothing can write through to your real home). Pre-trust the throwaway repo so Codex doesn't stop on its folder-trust screen:

```sh
W=$(mktemp -d); export CODEX_HOME=$W/home; mkdir -p $CODEX_HOME
cp ~/.codex/auth.json $CODEX_HOME/ && chmod 600 $CODEX_HOME/auth.json
printf '[projects."%s/proj"]\ntrust_level = "trusted"\n' "$W" > $CODEX_HOME/config.toml
python3 -m venv $W/venv && $W/venv/bin/pip install pyte==0.8.2   # tui.py renders the screen with pyte
```

The runs behind the committed fixtures (`--sandbox`/`-a` go through to codex):

```sh
P=$W/venv/bin/python
$P capture.py $W run1 exec "Run the shell command 'echo hi' and then reply with just: done" --sandbox workspace-write
$P capture.py $W run2 exec "Run exactly this shell command: curl -sI https://example.com | head -1 . It needs network, so request escalated permission if it fails. Then reply with just: done" --sandbox workspace-write
$P capture.py $W run3 exec "Spawn exactly one subagent using your agent-spawning tool. Its task: reply with the word pong and nothing else. Wait for it, then reply with just: done" --sandbox workspace-write
$P capture.py $W run4 tui steps/tui-permission-interrupt-compact.json --permission deny --sandbox read-only -a on-request
AGENT_BOARD_SESSION=tile-123 $P capture.py $W ov3 tui steps/tui-permission-allow-blocking.json --permission slow-allow \
  --sandbox read-only -a on-request -c 'shell_environment_policy.exclude=["AGENT_BOARD_*"]'
$P make_fixtures.py $W $CODEX_HOME ../../fixtures/codex \
  run4=tui-permission-interrupt-compact ov3=tui-permission-allow-blocking-hook run3=exec-subagent run1=exec-shell run2=exec-sandboxed-network
```

Then check: `grep -rE "$USER|$W" ../../fixtures` must find nothing. Afterwards, delete `$W` (it holds a copy of your credentials).

- `hook.sh`: the capture hook. It saves the stdin payload and `AGENT_BOARD_*`/`CODEX_*` env, and optionally answers `PermissionRequest`.
- `tui.py`: a PTY driver with a pyte screen, following a JSON step list (`wait`, `type`, `key`, `until`, `screen`).
