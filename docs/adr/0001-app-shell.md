---
status: accepted
---
# App shell: Electron + TypeScript

We build the desktop app on Electron with TypeScript end to end (React renderer, Node main process and daemon), because `node-pty` + `xterm.js` are the proven PTY/terminal pair (VS Code), Chromium renders identically on every OS, and a single language lets one test harness (Vitest + Playwright's Electron driver) cover unit and end-to-end. We accept heavier RAM and bundle size.

## Considered options

- **Tauri v2 (Rust)** — small and fast, `portable-pty` works, but WebKit on macOS/Linux renders and performs differently from Chromium (xterm.js WebGL, canvas pan/zoom), and a second language splits the codebase and test harness.
- **Wails (Go)** — matches the maintainer's main language and `creack/pty` is solid, but Wails v3 is still pre-stable, the ecosystem is small, and it carries the same webview caveats as Tauri.

## Consequences

- Native modules (`node-pty`) must be rebuilt for Electron's ABI; the daemon runs on Electron's bundled Node (`ELECTRON_RUN_AS_NODE`) so one build serves both. SQLite uses the built-in `node:sqlite`, so it needs no rebuild (ADR-0005).
- E2E tests drive the real packaged app through Playwright's `_electron` API. Until packaging lands, they launch the built main bundle (`apps/desktop/out/main/index.js`) with the Electron binary; switch to the packaged executable in the packaging ticket.

## Amendments

**2026-10-09**:

- **Packaging.** `pnpm package` builds an unsigned, unpacked (no asar) macOS `.app` with electron-builder `--dir`. node-pty's N-API prebuilds load in Electron as they are, so the package skips the native rebuild (`npmRebuild: false`).
- **E2E tests stay on the built main bundle.** The suite still launches `apps/desktop/out/main/index.js`, so the dev loop needs no packaging step. Packaging takes about 10 s and a 320 MB copy. One more test, `e2e/packaged.spec.ts` (`pnpm test:e2e:packaged`, run in CI after `pnpm package`), launches the packaged executable. It checks that the app starts its own daemon from the package and that node-pty runs a shell session there. This replaces the plan above to switch the whole suite to the packaged executable.

**2026-10-10**: every window stays on the app. It opens no other window (`setWindowOpenHandler` denies all)
and navigates nowhere but the app's own page (`will-navigate`). An https link either would have opened goes to the OS
browser through the same https-only path as tracker links; anything else is dropped. Note text and tracker data come
from outside the app, so nothing they hold may load in an app window.

**2026-10-10**: the window chrome (`main/chrome.ts`).

- **macOS has no title bar** (`titleBarStyle: 'hiddenInset'`). The traffic lights float over the page: on the board, centred on the top islands' midline, left of the board-menu island (the maintainer's pick U2); in a popped-out session window, inline at the start of its header (W). The renderer knows the chrome from `window.agentBoard.windows.chrome` and sets `html[data-chrome='inset']`, which leaves room for the lights.
- **Window dragging** is limited to a thin strip along the top of the board, the traffic lights' corner (not while a session window is shown on the board, which then sits below the lights' row) and the board menu's empty space; in a popped-out window, its header's empty space (`-webkit-app-region: drag`, with every control `no-drag`). The board needs every other pointer event. macOS handles a double-click on a drag region (zoom, by the user's setting).
- **Full screen** hides the traffic lights: main tells the renderer (`window:fullScreen`), which sets `html[data-full-screen='true']` (`'false'` otherwise), and the island or header moves into the room they leave.
- **Windows and Linux keep the native frame**, with its window controls. `titleBarOverlay` was not needed for chrome C, whose islands float below a native title bar just as well.
