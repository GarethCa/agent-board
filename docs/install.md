# Install

agent-board installs from source, on macOS (Apple silicon or Intel). You need:

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

`pnpm package` builds an unsigned macOS app and installs it as `~/Applications/agent-board.app`, replacing any earlier copy, so there is nothing to drag. If agent-board is running, it quits it first and asks whether to reopen it afterwards; your sessions keep running in the daemon. It installs only once the build has succeeded, so a failed build never removes the app you have. `pnpm package --no-install` only builds, leaving the app in `apps/desktop/dist/`. Installing is macOS only. Your data lives in `~/Library/Application Support/agent-board`.

## Update

```sh
pnpm update:app
```

Run it in your clone whenever you want the latest release. If your clone predates the command and `pnpm update:app` is missing, run `git pull` once first. It fast-forwards the clone (`git pull --ff-only`), runs `pnpm install --frozen-lockfile` and `pnpm package` (which quits the app, installs the new one over `~/Applications/agent-board.app` and opens it again). It prints the old and new version and a link to the release notes. It never runs by itself.

- It refuses, and changes nothing, if the clone has uncommitted changes or has diverged from `origin`. It says what to do.
- If the build fails, the app you have stays installed. Fix the cause and run it again.
- Your sessions live in the daemon, not the app, so they keep running. If the daemon is from an older build than the new app, the app shows its **Restart daemon** banner. Restarting ends running sessions, so you choose when.
- `--no-launch` installs without opening the app, `--install-dir <dir>` installs elsewhere, and `--force` builds again even when you are up to date.
