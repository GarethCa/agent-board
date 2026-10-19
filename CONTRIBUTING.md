# Contributing to agent-board

Thanks for helping. agent-board is alpha and changes fast, so open an issue to talk about anything bigger than a small fix before you start on it.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Install the prerequisites in the README's [Install](README.md#install), then:

```sh
git clone https://github.com/GarethCa/agent-board.git
cd agent-board
pnpm build
```

`pnpm build` installs dependencies first. `pnpm --filter @agent-board/desktop dev` runs the app with hot reload. You don't need `claude` or `codex` installed to develop or test: the test suite uses fakes (see [Tests](#tests)).

Before you change anything, read:

- [`CONTEXT.md`](CONTEXT.md): the domain glossary. Use its words (zone, tile, session, harness, edge) in code, tests, issues and PRs, and avoid the synonyms it lists.
- [`docs/adr/`](docs/adr): the decisions already made. If your change goes against one, say so in the PR and update the ADR in the same PR.

## Repo layout

```text
apps/desktop/          Electron app: main process, preload, React renderer, Playwright e2e and visual tests
packages/daemon/       agent-board daemon: JSON-RPC over a local socket, hook ingress, SQLite migrations
packages/fake-harness/ Fake claude/codex CLIs and the guard that keeps tests off the real ones
packages/tracker/      Issue trackers (Linear, GitHub) behind one interface, recorded-HTTP fixtures, keychain credentials
fixtures/              Real Codex hook payloads captured for tests
docs/                  The tour, quick start, install, FAQ, troubleshooting and how it works
docs/adr/              Architecture decision records
docs/assets/           Logo and the README's screenshots
scripts/               Dev scripts: update-app updates a checkout and installs its app; readme-screenshots redraws the README's screenshots; visual and check-local run the merge gate; codex-capture records real Codex hook payloads into fixtures/
CONTEXT.md             Domain glossary
```

How the pieces fit together is in [How it works](docs/how-it-works.md).

## Issues, branches and pull requests

- **Issues** are on GitHub. For a bug, include the build from the app's window title and the steps to reproduce it. For a feature, say what you are trying to do; the maintainer may already have it planned.
- **Branch** from `main`, named after the change in lowercase: `fix-tile-overlap`, `chat-view-search`.
- **PR title** says what the change does: `Keep expanded tiles apart`. **Commits** are written the same way. Don't put tracker IDs in branch names, commit messages or titles.
- Keep a PR to one change. Fill in the PR template: its first line is `Fixes #<n>` when it closes a GitHub issue, then, for a reader who hasn't seen the issue, what the **problem** is, what the **change** does about it, and **how it's implemented**, then how a reviewer can check it. Keep those sections true to the head commit: update them when a later push changes the approach.
- Never push to `main` or force-push. Every change lands through a reviewed PR that is squash-merged once its checks are green.

## Tests

**Write the test first.** Each change starts with a failing test that describes the behaviour, then the code that makes it pass. Test behaviour through public interfaces (the daemon's JSON-RPC API, the app's UI), not private functions.

**Tests never spend tokens.** Never call the real `claude` or `codex` from a test. Use the fake binaries in [`packages/fake-harness`](packages/fake-harness/README.md): they replay scripted scenarios and make the same hook calls and transcript writes as the real CLIs. A guard fails the run if a test reaches a real one. If you need a scenario the fakes don't have, add it to the fakes.

| Command              | What it runs                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm lint`          | ESLint over the repo                                                                                   |
| `pnpm typecheck`     | `tsc --noEmit` in every package                                                                        |
| `pnpm test`          | Vitest unit and integration tests                                                                      |
| `pnpm test:e2e`      | Playwright drives the built app (run `pnpm build` first)                                               |
| `pnpm test:visual`   | The visual spec only, against this platform's baselines                                                |
| `pnpm visual:check`  | The visual spec natively, against this machine's baselines                                             |
| `pnpm visual:update` | Regenerates this machine's baselines (see [Visual baselines](#visual-baselines))                       |
| `pnpm knip`          | knip: unused files, exports and dependencies, as `knip.json` sets out                                  |
| `pnpm check:pr`      | The per-PR gate: only the checks the diff needs (see below), with a result table to paste into the PR  |
| `pnpm check:local`   | The full gate: all of the above plus the Markdown lint and knip, in parallel, with a result table      |
| `pnpm check`         | Lint through e2e and the visual checks, then packages the macOS `.app` and smoke-tests it (macOS only) |

**E2E leaves nothing running.** Specs import `test` from `e2e/launch.ts`, whose teardown after every test closes the apps it launched, stops their daemons and deletes their data dirs, and the run fails if a daemon still serves one. A daemon whose data dir is gone exits on its own as well (ADR-0002). To check by hand that a run left nothing: `ps -axo pid=,command= | grep ab-e2e | grep -v grep` prints nothing.

**E2E never steals focus.** Every e2e launch sets `AGENT_BOARD_E2E_BACKGROUND=1` (`e2e/launch.ts`, and the packaged smoke test). In that mode `src/main/background.ts` makes the app an accessory app on macOS (no Dock icon, never activated), so a test run never takes focus or switches Spaces. Playwright drives input over CDP, which needs no OS focus; a test that needs real focus must force it in the page. Without the variable the app activates and focuses normally.

**E2E draws nothing on screen.** Every e2e launch also sets `AGENT_BOARD_HEADLESS=1`. Its windows, the board and popped-out ones alike, are then created hidden and never shown, and paint offscreen (Electron's offscreen rendering): the page renders, animates, takes Playwright's input and gives its screenshots, including the visual baselines, but WindowServer has nothing to composite. Offscreen paint is in software at one device pixel per CSS pixel (`devicePixelRatio` is 1) whatever the display, so e2e never sees HiDPI behaviour. To watch a run, or to check something on a HiDPI display at its own scale, set `AGENT_BOARD_HEADED=1`: the windows then show without taking focus.

```sh
AGENT_BOARD_HEADED=1 pnpm --filter @agent-board/desktop exec playwright test e2e/tiles.spec.ts
```

**E2E runs three tests at once.** Each test launches an Electron app and its daemon, so `playwright.config.ts` caps the workers at three rather than Playwright's half of the cores: the load average, not WindowServer, is what stalls the Mac when two gates overlap. Set `AGENT_BOARD_E2E_WORKERS` (a count, or a share of the cores such as `50%`) to run more or fewer.

### Visual baselines

`e2e/visual.spec.ts` compares screenshots with PNGs committed in `e2e/visual.spec.ts-snapshots/`, for macOS (`-darwin`). The spec never skips: a missing baseline for the platform it runs on is a failure. A UI change that moves pixels fails it until you regenerate the baselines:

```sh
pnpm build
pnpm visual:update   # this machine's (native) baselines only
```

Look at each PNG that changed (`git diff --stat` lists them), then commit them with the change.

**The gate is native macOS only, and runs on your machine.** There is no CI, so `pnpm check:pr` and `pnpm check:local` run here. The `-darwin` baselines are painted offscreen (see [E2E draws nothing on screen](#tests)), so the display's scale and colour profile don't reach them; they are still tied to the macOS and Electron versions that made them: if another Mac disagrees, regenerate them there and say so in the PR. The spec fixes how the app draws (software rendering, one device pixel per CSS pixel, no font hinting or LCD text, motion off, fonts loaded and a settled frame before each shot, UTC and `en-US`), so every run on a platform gives identical PNGs; its own fonts are the files in `e2e/fonts`.

Run `pnpm check:pr` before you open a PR, and paste its table into the PR. It diffs your branch against `origin/main`, prints what it chose and why, and runs lint, typecheck and the Markdown lint in parallel with: `vitest related` on the changed files; the e2e specs that `E2E_MAP` in `scripts/check-pr/select.ts` maps the changed files to (an app file in no entry runs the smoke set: `acceptance`, `app`, `tiles` and `session`); and the visual tests when renderer CSS/TSX or baselines changed. A change to the gate, the shared config, the e2e helpers, the fake CLIs, the daemon protocol or the shared/preload code runs the full `pnpm check:local` instead. Add a source-to-spec line to `E2E_MAP` when you add a spec. The full suite also runs on `main` after merges.

`pnpm check:local` is the full gate, with its steps running at the same time (the build, lint, typecheck, Markdown lint and knip together, then the unit tests, then the e2e and visual runs once the build passes). knip fails on an unused file, export or dependency: delete it, or, if it is used where knip can't see (electron-builder packages `node-pty` and the xterm addons from the app's own dependencies), say so in `knip.json`. `check:local` also runs the Markdown lint (`markdownlint-cli2@0.23.2`). On Linux with no display it runs the end-to-end tests on a virtual display with `scripts/e2e-headless.sh`; install `xvfb`, `openbox` (window tests need a window manager) and Electron's libraries first. A few journeys are macOS-only (the keychain, and the app staying open with no windows) and skip elsewhere.

The gate is the `pnpm check:pr` table on the PR, run on the PR's head commit, and a `pnpm check:local` run on `main` after merging.

## Docs

- The README and the pages in `docs/` describe the latest release. If your PR changes a command they or this guide show, update it in the same PR. `pnpm readme:screenshots` redraws its screenshots from a seeded demo board.
- New architectural decisions get an ADR in `docs/adr/`. New domain terms go in `CONTEXT.md`.

## Licence

agent-board is under the [Functional Source License 1.1, Apache 2.0 future licence](LICENSE) (FSL-1.1-ALv2).

Before a contribution can be merged, you need to agree to the [Contributor Licence Agreement](CLA.md). You keep the
copyright in your work; the agreement lets the project use it and offer it under any licence, including a commercial
one, so the project can change its licence or offer paid editions without asking every past contributor. Agree to it
by ticking its box in the PR template, or by commenting "I have read the CLA and I agree to it" on your PR. You only
need to do it once.
