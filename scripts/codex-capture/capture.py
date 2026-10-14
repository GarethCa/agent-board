#!/usr/bin/env python3
"""Run the real codex once with a capture hook on every event. Spends real tokens: keep prompts tiny.

Usage:
  capture.py <work-dir> <run> exec "<prompt>" [--permission allow|deny|slow-allow] [codex args...]
  capture.py <work-dir> <run> tui <steps.json> [--permission ...] [codex args...]

<work-dir> holds proj/ (a throwaway git repo Codex runs in) and cap/<run>/<Event>/*.json.
CODEX_HOME must point at a throwaway directory (never ~/.codex); copy auth.json into it first.
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
          "SubagentStart", "SubagentStop", "Stop", "Interrupt", "PreCompact", "PostCompact"]

home = os.environ.get("CODEX_HOME")
if not home or os.path.realpath(home) == os.path.realpath(os.path.expanduser("~/.codex")):
    sys.exit("refusing to run: set CODEX_HOME to a throwaway directory, not ~/.codex")

work, run, mode, arg, rest = os.path.abspath(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
decision = ""
if rest[:1] == ["--permission"]:
    decision, rest = rest[1], rest[2:]
proj, cap = os.path.join(work, "proj"), os.path.join(work, "cap", run)
os.makedirs(cap, exist_ok=True)
if not os.path.isdir(os.path.join(proj, ".git")):
    subprocess.run(["git", "init", "-q", proj], check=True)

hook = os.path.join(HERE, "hook.sh")
args = ["-C", proj]
for ev in EVENTS:
    extra = f" {decision}" if ev == "PermissionRequest" and decision else ""
    timeout = 600 if ev == "PermissionRequest" else 3
    args += ["-c", f'hooks.{ev}=[{{hooks=[{{type="command",command="{hook} {cap}/{ev}{extra}",timeout={timeout}}}]}}]']
args += ["-c", f'notify=["{hook}","{cap}/notify"]']

if mode == "exec":
    cmd = ["codex", "exec", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--json"] + args + rest + [arg]
    with open(os.path.join(cap, "exec.jsonl"), "w") as out:
        p = subprocess.run(cmd, cwd=proj, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.PIPE, text=True, timeout=240)
    print("exit", p.returncode, p.stderr[-2000:])
else:
    cmd = ["codex", "--dangerously-bypass-hook-trust"] + args + rest
    subprocess.run([sys.executable, os.path.join(HERE, "tui.py"), arg, "--"] + cmd, cwd=proj)
