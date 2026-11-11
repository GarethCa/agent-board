# apps/desktop: code map

The Electron app. It draws the board and talks to the daemon (`packages/daemon`); it keeps no board state of its own. Use this map to find a file, not a search of the whole folder.

## The four parts

| Folder | What runs there |
|---|---|
| `src/main/` | Electron's main process: windows, menus, notifications, and one module per area that passes the window's calls on to the daemon. `index.ts` starts it. |
| `src/preload/` | The bridge into each window. `api.ts` (about 1,600 lines) types `window.agentBoard` and names every IPC channel (`*_IPC`). `index.ts` builds it. |
| `src/renderer/src/` | The React app in each window. `main.tsx` mounts `App.tsx`. |
| `src/shared/` | Code both main and the renderer use: themes, design tokens, errors. |

## One call from the window to the daemon

Take the setting "Compact agents' context at" as an example:

1. Renderer: `chrome/CompactWindowSetting.tsx` calls `window.agentBoard.flowEdges.settings()`.
2. Preload: `api.ts` types `flowEdges` and names `FLOW_EDGE_IPC`. `index.ts` sends it with `invoke(FLOW_EDGE_IPC.settings)`.
3. Main: `main/flow-edges.ts` hands that channel to the daemon's `settings.get` with `passthrough`, and forwards the daemon's `settings.updated` event with `forwardEvents`.
4. Daemon: the method is in `DaemonMethods` (`packages/daemon/src/protocol.ts`) and is served from `settings.ts`.

A new call touches all four. Find the area's existing call and copy it.

## The renderer by folder

| Folder | What is in it |
|---|---|
| `board/` (about 210 files) | The canvas: tiles (`TileNode.tsx`, `tile*.ts`), zones (`ZoneNode.tsx`, `zone-*.ts`), shelves, folding, characters, flow edges, dialogs. `Board.tsx` puts it together; `use-board-data.ts` holds what it shows. Subfolders: `items/` (notes, documents, memories, queues, steps, clocks, links), `connectors/`, `editing/`, `ask/`. |
| `session/` (about 85 files) | An agent's session window: terminal, chat, sidebar, tabs. |
| `chrome/` | The app around the board: toolbar, Settings (`settings-ia.ts` lists every setting and where it lives). |
| `ui/` | Shared controls: buttons, menus, popovers, fields. |
| `inbox/` | The needs-you inbox. |
| `master/`, `crews/`, `orchestrators/` | The master's tile, crew cards, orchestrator views. |
| `gate/`, `review/`, `plan/`, `doc/` | The merge gate, reviews, plans, documents. |
| `onboarding/`, `keys/`, `windows/`, `demo/` | First run, keyboard shortcuts, extra windows, the demo board. |

Most `*Gallery.tsx` files are a component's states for the visual specs.

## Tests

- Unit tests sit next to the code (`tiles.ts` is tested in `tiles.test.ts`). Run them first, before any Playwright run.
- Playwright specs are in `e2e/` (about 140). Helpers: `launch.ts` (start the app on a temporary data dir), `agent-helpers.ts`, `board-helpers.ts`, `master-helpers.ts`, `settings-helpers.ts`, `windows.ts`.
- Visual specs are in `e2e/visual/` (`shared.ts` holds their setup); their baselines are in `e2e/visual.spec.ts-snapshots/`.
- Each Playwright run launches the app and costs far more than a unit test: name the spec, and use `-g` for one test.
