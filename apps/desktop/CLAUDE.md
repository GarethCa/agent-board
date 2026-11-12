# apps/desktop: code map

The Electron app. It draws the board and talks to the daemon (`packages/daemon`); it keeps no board state of its own. Use this map to find a file, not a search of the whole folder.

## The four parts

| Folder | What runs there |
|---|---|
| `src/main/` | Electron's main process: windows, menus, notifications, and one module per area that passes the window's calls on to the daemon. `index.ts` starts it. |
| `src/preload/` | The bridge into each window. `api.ts` (about 1,700 lines) types `window.agentBoard` and names every IPC channel (`*_IPC`). `index.ts` builds it. |
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

## Big files: read them in parts

Every source file over 300 lines, by folder. `main/`, `preload/` and `shared/` are under `src/`; the other folders are the renderer's, under `src/renderer/src/`. Find the symbol first (go to definition, or `rg -n`), then read about 80 lines around it.

| Folder | Files |
|---|---|
| `main/` | `index.ts` (starts the main process), `web-tabs.ts` (web tab sessions) |
| `preload/` | `api.ts` (types `window.agentBoard`, every `*_IPC`), `index.ts` (builds it) |
| `shared/` | `theme-packs.ts` (other projects' palettes as theme packs), `theme-pack-tokens.ts` (a pack's tokens from its palette) |
| `board/` | `Board.tsx` (puts the canvas together), `menu-model.tsx` (agent, shell and zone menus as data), `HybridTile.tsx` (an agent's tile with its character), `AddZonePopover.tsx` (a new zone, and binding it to a source), `character-figures.tsx` (how a character is drawn in each style), `displace.ts` (making room round a tile expanded in place), `TileGallery.tsx`, `EdgeRules.tsx` (a flow edge's rules), `ZoneNode.tsx`, `NewAgentDialog.tsx`, `tiles.ts`, `use-board-data.ts`, `flow-edges.ts` (flow edges as the board draws them) |
| `board/items/` | `StepsCard.tsx`, `QueueCard.tsx`, `TodoCard.tsx`, `ShapeNode.tsx`, `crew-card.ts`, `shapes/catalogue.ts` (every shape: name, group, other words, size, drawing) |
| `board/connectors/` | `ConnectorEdge.tsx`, `geometry.ts` (a line's path: straight, elbow or curved), `line.tsx`, `route.ts` (a line's way round the objects between its ends) |
| `board/editing/`, `board/ask/` | `use-editing.ts` (editing the board's nodes and connectors), `AskClaude.tsx` (the ask popover) |
| `session/` | `AgentShelves.tsx` (a session's shelves and what their rows open), `SessionBody.tsx` (what a session window or an expanded tile shows), `use-window-panes.ts` (the window's panes and their strips), `ChatStreams.tsx` (the chat's items), `SessionDetails.tsx`, `TerminalPane.tsx`, `SessionWindow.tsx`, `chat.ts`, `chat-parts.tsx`, `tabs.ts` (the tabs in a session window), `terminal-sharpness.ts` (a WebGL terminal kept sharp under zoom) |
| `chrome/` | `SettingsWindow.tsx`, `Spotlight.tsx` and `spotlight-results.ts` (the ⌘K switcher), `CreateToolbar.tsx` |
| `ui/` | `ComponentGallery.tsx` (every control in every state), `Menu.tsx` |
| `inbox/` | `GroupedInbox.tsx`, `Inbox.tsx` |
| `crews/` | `PrefabEditor.tsx`, `prefab-flow.ts` (a crew prefab as its flow editor draws it) |
| the rest | `master/MasterPanel.tsx`, `gate/GateControls.tsx`, `plan/PlanTab.tsx`, `onboarding/ConnectStep.tsx`, `windows/SessionWindows.tsx`, `keys/registry.ts` (every key the app answers to) |

## Styles

The CSS is in a few big files; search them for the class name, never read one whole. All of them are under `src/renderer/src/`. `app.css` (about 16,000 lines) holds most of the renderer's styles, `theme-packs.css` (about 6,000) the theme packs, and `tokens.css` the design tokens. Areas with their own sheet: `chrome/chrome.css`, `ui/ui.css`, `onboarding/onboarding.css`. Raw colours, spacing, radii, fonts, shadows and motion belong in tokens: `tokens.test.ts` and `swatch-folding.test.ts`, beside `tokens.css`, check them.

## Tests

- Unit tests sit next to the code (`tiles.ts` is tested in `tiles.test.ts`). Run them first, before any Playwright run.
- Playwright specs are in `e2e/` (about 140). Helpers: `launch.ts` (start the app on a temporary data dir), `agent-helpers.ts`, `board-helpers.ts`, `master-helpers.ts`, `settings-helpers.ts`, `windows.ts`.
- Visual specs are in `e2e/visual/` (`shared.ts` holds their setup); their baselines are in `e2e/visual.spec.ts-snapshots/`.
- Each Playwright run launches the app and costs far more than a unit test: name the spec, and use `-g` for one test.
