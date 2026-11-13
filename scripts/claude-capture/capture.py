#!/usr/bin/env python3
"""Record the real Claude Code's start-up screens as raw PTY bytes, for the tests to replay. Sends no prompt.

Usage: capture.py <work-dir> [--out DIR] [--cols N] [--rows N] [--quiet SECONDS] [--timeout SECONDS]

Starts `claude` twice in a PTY, with nothing typed at it: once in a folder it has never seen (its trust screen), once in
a folder its config already trusts (its empty prompt). Each run is recorded until the screen has been still for
--quiet seconds, then Claude is killed. Nothing is ever typed, so no prompt reaches the model and no tokens are spent.

CLAUDE_CONFIG_DIR must point at a throwaway directory (never ~/.claude), and <work-dir> must be outside your home, so
the folder Claude shows is no path of yours. Sign in with CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or
ANTHROPIC_API_KEY in the environment. Writes <out>/startup-<version>.bin and startup-<version>-trust.bin, each with
a .json of its version, size, what it shows and the time of each chunk, so the tests replay it at the pace it was
drawn. Your name (from Claude's config, git and macOS), email, organisation, user name and home are replaced with as
many `x`s, so the screen keeps its layout; each screen is printed as text for you to read before you commit it.
"""
import argparse, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
REAL = os.path.realpath(os.path.expanduser("~/.claude"))
HOME = os.path.realpath(os.path.expanduser("~"))

ap = argparse.ArgumentParser(description="Record Claude Code's start-up screens. Sends no prompt.")
ap.add_argument("work")
ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "fixtures", "claude", "tui"))
ap.add_argument("--cols", type=int, default=100)
ap.add_argument("--rows", type=int, default=30)
ap.add_argument("--quiet", type=float, default=4.0)
ap.add_argument("--timeout", type=float, default=60.0)
args = ap.parse_args()

config = os.environ.get("CLAUDE_CONFIG_DIR")
if not config:
    sys.exit("refusing to run: set CLAUDE_CONFIG_DIR to a throwaway directory, not ~/.claude")
config = os.path.realpath(config)
if config == REAL or config.startswith(REAL + os.sep) or config == HOME:
    sys.exit("refusing to run: set CLAUDE_CONFIG_DIR to a throwaway directory, not ~/.claude")

work = os.path.realpath(args.work)
if work == HOME or work.startswith(HOME + os.sep):
    sys.exit(f"refusing to run: {args.work} is in your home, and Claude shows its folder; use a short path such as /tmp/cc")
if not (os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")):
    print("warning: no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY: Claude may stop on its login screen", file=sys.stderr)

version = subprocess.run(["claude", "--version"], capture_output=True, text=True, check=True).stdout.split()[0]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    sys.exit(f"can't read Claude Code's version from {version!r}")

trusted, untrusted = os.path.join(work, "proj"), os.path.join(work, "new")
for folder in (trusted, untrusted):
    os.makedirs(folder, exist_ok=True)

# Its settings: onboarding done, the trusted folder trusted, an API key approved, and no hooks, MCP or updates of yours.
state_path = os.path.join(config, ".claude.json")
os.makedirs(config, exist_ok=True)
state = json.load(open(state_path)) if os.path.exists(state_path) else {}
state.update({"hasCompletedOnboarding": True, "theme": state.get("theme", "dark"), "autoUpdates": False})
state.setdefault("projects", {})[trusted] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}
state["projects"].pop(untrusted, None)
key = os.environ.get("ANTHROPIC_API_KEY")
if key:
    state.setdefault("customApiKeyResponses", {"approved": [], "rejected": []})["approved"] = [key[-20:]]
json.dump(state, open(state_path, "w"), indent=2)

env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_BOARD_")}
env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "DISABLE_AUTOUPDATER": "1"})

# Answers to the terminal's queries Claude makes as it starts, as a terminal would give them. None holds a CR, so none
# can submit anything or pick a row.
ANSWERS = [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
           (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x1b\\"), (b"\x1b[c", b"\x1b[?62;22c")]
LONGEST_QUERY = max(len(query) for query, _ in ANSWERS)


def record(cwd):
    """Claude's bytes from its start until its screen is still, typing nothing at it, and when each chunk came:
    [ms from the start, offset it ends at]."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe("claude", ["claude"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))
    data, chunks, start, last = b"", [], time.time(), None
    try:
        while True:
            if time.time() - start >= args.timeout:
                print(f"warning: the screen in {cwd} never stayed still for {args.quiet}s in {args.timeout}s: the "
                      "recording ends mid-redraw, and the tests replay that", file=sys.stderr)
                break
            if last is not None and time.time() - last >= args.quiet:
                break
            ready, _, _ = select.select([fd], [], [], 0.1)
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            # A query split across two reads is answered too: look at the tail of what came before with it.
            tail = data[-(LONGEST_QUERY - 1):]
            for query, answer in ANSWERS:
                at = (tail + chunk).rfind(query)
                if at != -1 and at + len(query) > len(tail):
                    os.write(fd, answer)
            data, last = data + chunk, time.time()
            chunks.append([round((last - start) * 1000), len(data)])
    finally:
        # The pid pty.fork gave us, which leads its own session: Claude and what it started, never a pattern match.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)
    return data, chunks


def command_output(*command):
    try:
        return subprocess.run(command, capture_output=True, text=True).stdout.strip()
    except OSError:
        return ""


def private_strings():
    """What of yours Claude may draw: your name as Claude's config, git and macOS know it (whole, and each word of it),
    your account's email and organisation, your user name and your home."""
    account = (json.load(open(state_path)) if os.path.exists(state_path) else {}).get("oauthAccount") or {}
    names = [account.get("displayName"), command_output("git", "config", "user.name"), command_output("id", "-F")]
    found = names + [account.get("emailAddress"), account.get("organizationName"), os.environ.get("USER"), HOME]
    found += [word for name in names if name for word in re.findall(r"[^\W\d_]{3,}", name)]
    return sorted({s for s in found if s and len(s) >= 3}, key=len, reverse=True)


def scrub(data):
    """`data` with each private string replaced by as many `x`s as its bytes, so every chunk's offset still holds."""
    for secret in private_strings():
        raw = secret.encode()
        data = data.replace(raw, b"x" * len(raw))
    text = data.decode("utf-8", "replace")
    for name in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
        if os.environ.get(name) and os.environ[name] in text:
            sys.exit(f"refusing to save: the recording holds {name}")
    if re.search(r"[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}", text):
        sys.exit("refusing to save: the recording holds an email address; look at it and add it to private_strings")
    return data


def as_text(data):
    """The words a recording draws, roughly, for you to read by eye: colours and styles dropped, a move along the line
    (Claude places each word with one, never with a space) read as a space, any other escape (a move to another line,
    an erase) as a line break, and blank lines skipped."""
    text = data.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-9;:]*m|\x1b[78]", "", text)
    text = re.sub(r"\x1b\[[0-9]*[GC]", " ", text)
    text = re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[@-_]", "\n", text)
    return "\n".join(re.sub(r" +", " ", line).rstrip() for line in re.split(r"[\r\n]+", text) if line.strip())


def save(name, data, chunks, screen):
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, f"{name}.bin"), "wb") as out:
        out.write(data)
    with open(os.path.join(args.out, f"{name}.json"), "w") as meta:
        json.dump({"version": version, "cols": args.cols, "rows": args.rows, "screen": screen, "recorded": True,
                   "chunks": chunks}, meta, indent=2)
        meta.write("\n")
    print(f"\n----- {name}.bin ({len(data)} bytes in {len(chunks)} chunks, {screen}): read it for anything of yours -----")
    print(as_text(data))
    print(f"----- end of {name}.bin -----")


def shows(data, *marks):
    """Whether the recording draws any of `marks`, read as its words (`as_text`): Claude puts no space bytes between
    its words, so a mark is never in the raw bytes."""
    words = " ".join(as_text(data).split())
    return any(mark in words for mark in marks)
TRUST_MARKS = ("Quick safety check", "trust this folder", "Do you trust the files")


def shows_input_box(data):
    """Whether the last `❯` Claude drew is its input box's: drawn just after a rule of `─` and just before another. A
    start-up menu drawn after the prompt puts its own `❯` last, with no rules round it."""
    at, rule, near = data.rfind("❯".encode()), ("─" * 20).encode(), 4096
    return at != -1 and rule in data[max(0, at - near):at] and rule in data[at:at + near]


trust, trust_chunks = record(untrusted)
trust = scrub(trust)
if shows(trust, *TRUST_MARKS):
    save(f"startup-{version}-trust", trust, trust_chunks, "trust")
else:
    print("no trust screen came up in a new folder: none saved", file=sys.stderr)

prompt, prompt_chunks = record(trusted)
prompt = scrub(prompt)
if shows(prompt, *TRUST_MARKS):
    sys.exit("the trusted folder still showed the trust screen: nothing saved for the prompt")
if not shows_input_box(prompt):
    print(as_text(prompt), file=sys.stderr)
    sys.exit("no empty input box came up (a login, onboarding or other menu? its text is above): nothing saved for the prompt")
save(f"startup-{version}", prompt, prompt_chunks, "prompt")
