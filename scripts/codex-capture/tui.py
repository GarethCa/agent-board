#!/usr/bin/env python3
"""Drive a TUI in a PTY. Usage: tui.py <steps.json> -- cmd args...
Steps: ["wait",s] ["type",text] ["key",name] ["screen"] ["until",regex,s]. Env passes through."""
import fcntl, json, os, pty, re, select, struct, sys, termios, time
import pyte

i = sys.argv.index("--")
steps, cmd = json.load(open(sys.argv[1])), sys.argv[i + 1:]
ROWS, COLS = 45, 140
screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
KEYS = {"enter": b"\r", "esc": b"\x1b", "down": b"\x1b[B", "up": b"\x1b[A", "space": b" ", "tab": b"\t",
        "ctrl-c": b"\x03", "left": b"\x1b[D", "right": b"\x1b[C"}

def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return False
            if b"\x1b[6n" in data:
                os.write(fd, f"\x1b[{screen.cursor.y+1};{screen.cursor.x+1}R".encode())
            if b"\x1b]10;?" in data: os.write(fd, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
            if b"\x1b]11;?" in data: os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
            if b"\x1b[c" in data: os.write(fd, b"\x1b[?62;22c")
            try: stream.feed(data)
            except Exception: pass
    return True

def text(): return "\n".join(l.rstrip() for l in screen.display if l.strip())

for st in steps:
    op = st[0]
    if op == "wait": pump(st[1])
    elif op == "type":
        for ch in st[1]: os.write(fd, ch.encode()); pump(0.02)
    elif op == "key": os.write(fd, KEYS[st[1]]); pump(0.3)
    elif op == "screen": print("=" * 20, "SCREEN", "=" * 20); print(text())
    elif op == "until":
        end = time.time() + st[2]
        while time.time() < end and not re.search(st[1], text()): pump(0.3)
        print(f"[until {st[1]!r}: {'hit' if re.search(st[1], text()) else 'TIMEOUT'}]")
try: os.kill(pid, 9)
except ProcessLookupError: pass
