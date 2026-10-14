#!/usr/bin/env python3
"""Turn capture runs into sanitised fixtures.

Usage: make_fixtures.py <work-dir> <codex-home> <out-dir> <run>=<scenario> [<run>=<scenario> ...]
Runs listed first win when picking the single hooks/<Event>.json example, so list TUI runs first.
"""
import json, os, re, sys

work, home, out = (os.path.abspath(a) for a in sys.argv[1:4])
runs = [a.split("=", 1) for a in sys.argv[4:]]
REPLACE = [(os.path.join(work, "proj"), "/Users/dev/code/demo"), (home, "/Users/dev/.codex"),
           (os.path.expanduser("~"), "/Users/dev")]

def clean(o):
    if isinstance(o, dict): return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list): return [clean(v) for v in o]
    if isinstance(o, str):
        for a, b in REPLACE: o = o.replace(a, b)
        return re.sub(r"gAAAAA[A-Za-z0-9_\-=]{20,}", "gAAAAA<encrypted-redacted>", o)
    return o

def dump(obj, path):
    with open(path, "w") as fh: fh.write(json.dumps(obj, indent=2) + "\n")

os.makedirs(f"{out}/hooks", exist_ok=True); os.makedirs(f"{out}/scenarios", exist_ok=True)
first, notify = {}, None
for run, name in runs:
    items, cap = [], f"{work}/cap/{run}"
    for ev in sorted(os.listdir(cap)):
        if not os.path.isdir(f"{cap}/{ev}"): continue
        for f in os.listdir(f"{cap}/{ev}"):
            if not f.endswith(".json"): continue
            payload = clean(json.load(open(f"{cap}/{ev}/{f}")))
            item = {"kind": "notify", "payload": payload} if ev == "notify" else {"kind": "hook", "event": ev, "payload": payload}
            items.append((int(re.sub(r"\D", "", f)), item))
    items.sort(key=lambda x: x[0])
    with open(f"{out}/scenarios/{name}.jsonl", "w") as fh:
        for ts, it in items:
            fh.write(json.dumps({"t_ms": (ts - items[0][0]) // 1_000_000, **it}) + "\n")
    sessions = {it["payload"]["session_id"] for _, it in items if it["kind"] == "hook"}
    for _, it in items:
        if it["kind"] == "hook": first.setdefault(it["event"], it["payload"])
        elif notify is None and it["payload"].get("thread-id") in sessions: notify = it["payload"]  # skip title/subagent threads
for ev, p in first.items(): dump(p, f"{out}/hooks/{ev}.json")
if notify: dump(notify, f"{out}/notify-agent-turn-complete.json")
for behaviour, extra in [("allow", {}), ("deny", {"message": "denied by capture hook"})]:
    dump({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": behaviour, **extra}}},
         f"{out}/hooks/PermissionRequest.response-{behaviour}.json")
print("events:", sorted(first))
