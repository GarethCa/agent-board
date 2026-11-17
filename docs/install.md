# Install

agent-board installs from source, on macOS (Apple silicon or Intel) or [Linux](#linux) (x86-64). You need:

- [Node.js](https://nodejs.org) 24 or later, and pnpm 11: `npm install -g pnpm@11`.
- `git`.
- The [`claude`](https://code.claude.com/docs) CLI, installed and logged in. The [`codex`](https://github.com/openai/codex) CLI is optional.
- Optional, for GitHub zones, issues and pull requests on tiles: the [`gh`](https://cli.github.com) CLI, logged in.

The CLIs must be on your login shell's `PATH`: agent-board reads it when it starts, because an app opened from the Dock gets a bare one.

```sh
git clone https://github.com/GarethCa/agent-board.git
cd agent-board
pnpm install
pnpm package
```

`pnpm package` builds an unsigned macOS app and installs it as `~/Applications/agent-board.app`, replacing any earlier copy, so there is nothing to drag. If agent-board is running, it quits it first and asks whether to reopen it afterwards; your sessions keep running in the daemon. It installs only once the build has succeeded, so a failed build never removes the app you have. `pnpm package --no-install` only builds, leaving the app in `apps/desktop/dist/`. Your data lives in `~/Library/Application Support/agent-board`.

## Linux

On Linux (x86-64), the same commands build the app, with the same tools as on macOS; electron-builder downloads the rest.

`pnpm package` builds a `.deb` and a `.tar.gz` in `apps/desktop/dist/`. On Debian, Ubuntu and their kin it then installs the `.deb` with `sudo apt-get install --reinstall`, so it asks for your password. apt installs the libraries the app needs too (Electron's, and `git`), puts the app in `/opt/agent-board`, adds `agent-board` to your `PATH` and to your app menu, and sets up Chromium's sandbox. If agent-board is running, `pnpm package` quits it first and asks whether to reopen it, as on macOS; your sessions keep running in the daemon. Without apt it builds only the tar.gz and installs nothing: unpack it anywhere and run `agent-board` in it. Run `pnpm package` as yourself, not with `sudo`: it asks for sudo itself, for the apt step only. `pnpm package --no-install` only builds. `--install-dir` is macOS only.

Your data lives in `~/.config/agent-board` (or `$XDG_CONFIG_HOME/agent-board`), and Linear keys in your desktop's keyring through `secret-tool` (the `.deb` installs it; with the tar.gz, install `libsecret-tools`).

Linux is newer than macOS, and some things don't work there yet:

- **`pnpm update:app` is macOS only.** To update, run `git pull`, `pnpm install` and `pnpm package` in your clone.
- **x86-64 only.** An arm64 build is untested.
- **The tar.gz needs Chromium's sandbox set up by hand.** The `.deb` does it for you. Unpacked elsewhere, the app may not start on Ubuntu 24.04 and later, which restrict the user namespaces the sandbox needs; make `chrome-sandbox` in the unpacked folder owned by root with mode 4755 (`sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`).
- **Unsigned, and no apt repository.** You build and install it yourself, as on macOS.
- **macOS-only features don't apply:** the menu-bar icon, and the app staying open with no windows. On a desktop with no keyring, web tabs' logins are encrypted with a fixed key, as Chrome does there, which is no better than plain text.

## Update

```sh
pnpm update:app
```

Run it in your clone whenever you want the latest release. If your clone predates the command and `pnpm update:app` is missing, run `git pull` once first. It fast-forwards the clone (`git pull --ff-only`), runs `pnpm install --frozen-lockfile` and `pnpm package` (which quits the app, installs the new one over `~/Applications/agent-board.app` and opens it again). It is macOS only for now; on Linux, see [Linux](#linux). It prints the old and new version and a link to the release notes. It never runs by itself.

- It refuses, and changes nothing, if the clone has uncommitted changes or has diverged from `origin`. It says what to do.
- If the build fails, the app you have stays installed. Fix the cause and run it again.
- Your sessions live in the daemon, not the app, so they keep running. If the daemon is from an older build than the new app, the app shows its **Restart daemon** banner. Restarting ends running sessions, so you choose when.
- `--no-launch` installs without opening the app, `--install-dir <dir>` installs elsewhere, and `--force` builds again even when you are up to date.
