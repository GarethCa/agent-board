---
status: accepted
---
# Board: React Flow (xyflow)

We build the board on React Flow (`@xyflow/react`, MIT). Tiles are custom React nodes, zones are parent nodes that tiles live inside, hand-off edges are custom labelled edges, and the minimap comes free. Each representation (Hybrid in v1; Character, Token, Plain tile later) is one node-rendering component chosen through a registry, so styles are swappable per board or per tile.

Performance rules from day one: memoised node components, `onlyRenderVisibleElements`, no live terminals on the board (terminals render only in session windows), and state updates batched per animation frame.

## Considered options

- **tldraw** — the nicest whiteboard feel, but the SDK is source-available under the tldraw licence, not OSI open source: production use needs a licence key and shows a "made with tldraw" watermark unless you buy a commercial licence. That conflicts with an MIT app anyone can build and ship.
- **Excalidraw** — MIT and great for freehand, but it is a finished whiteboard app; embedding live, stateful React components as first-class elements fights its model.
- **Build our own** — maximum control, but pan/zoom, selection, edges and hit-testing are months of work that React Flow already does well.

## Amendments

**Update**:

- **Board items are nodes too.** A board item (a sticky note, text or shape, and later whiteboard kinds) is a React Flow node with one
  node type per kind, `item:<kind>`, so a kind can't replace the board's own node types. Kinds are registered in
  `ITEM_KINDS` (`apps/desktop/src/renderer/src/board/items/kinds.ts`), which gives each kind its name for messages,
  its component, default size, new data and minimap colour. This registry is separate from the representation
  registry: representations draw sessions, item kinds draw everything else. Items are children of their zone, like
  tiles, so they move with it. They draw above tiles (except shapes, which draw above their zone but below tiles, so one can frame agents), and among themselves in `z` order, kept as their order in the
  board's nodes, so changing an item's `z` changes what is on top.
- **Items made from what was pasted.** Images and link cards have no empty form to make, so their `ITEM_KINDS`
  entries have no `newData`: the board makes them from a paste or a drop (`items/paste.ts` sorts what arrived), and
  only a kind with `editsOnCreate` opens ready to type into. Images load through the `agent-board-image://` scheme,
  which the main process serves from the daemon's image store; the renderer's CSP allows that scheme and no remote
  images, so a link card's favicon is fetched and stored by the daemon, never loaded from the web by the renderer.
- **Fit on load only when there is something to fit.** The board fits its view when it opens only if it opened with
  something on it. React Flow holds a pending fit until the first nodes appear, so on an empty board the first note
  would otherwise jump to the middle of the view.

**Update**:

- **Connectors are React Flow edges**, of one type `connector`, drawn from the daemon's connectors. Every node type that a
  connector can join (zones, tiles and every item kind) is wrapped by `withConnectorHandles`, which adds four round
  handles (`top`, `right`, `bottom`, `left`), so a connector end is an object and a side. The board reads the drop itself
  (`onConnectEnd`) rather than React Flow's `onConnect`, since an object can be joined anywhere on it, and empty board
  makes a note. Flow edges (M2) are a second edge type with square ports, so the two never share handles.
- **A zone is joined by its tab or a handle**, not its body, where a drop makes a note in the zone.

**Update**:

- **A live terminal on the board, but only in an expanded tile.** The rule above, "no live terminals on the board", now reads: a
  compact tile attaches no terminal; one expanded in place does, for as long as it is expanded. The expanded tile is the
  same `tile` node, drawn by `ExpandedTile` instead of the representation when its data says `expanded`, at its own size
  (so culling with `onlyRenderVisibleElements` still sees it), over everything else (z-index above items and a dragged
  tile, in the order last brought to the front), and dragged only by its header (`dragHandle`). Its body is
  `nodrag nowheel nopan`, so the terminal takes the pointer, the wheel and the keyboard. Its zone keeps the compact
  tile's footprint: an expanded tile floats over its zone and never grows it. The 200-tile pan/zoom budget is unchanged,
  as compact tiles render as before.
- **Click expands, double-click maximises** (superseded below: a click now opens the session window unless
  the click setting says Expand in place). A click on a tile (not on its controls) expands it; a double-click opens its
  session window. The double-click is read from the second click's `detail`, as the first click has already swapped
  the compact tile for the expanded one. For `OPENING_DOUBLE_CLICK_MS` after it opens, an expanded tile's body takes no
  clicks and the view doesn't move to show it, so a second click lands on the expanded tile itself and maximises; a
  click is told to be that one by when it happened (`timeStamp`), not when a busy page handles it. Esc with the board
  focused collapses the one in front, then the next. (a click on bare board or a zone no longer collapses every
  expanded tile; one stays expanded until collapsed, by its button or Esc.)
- **The terminal waits to be clicked.** An expanded tile's terminal doesn't take the keyboard as it opens, so Esc, the
  arrow keys and the board's shortcuts still reach the board. Once clicked, Esc is the session's (Claude's "esc to
  interrupt"), and the board's keys stand aside, as for any field.
- **One terminal per session at a time.** A session shown in its session window, on the board or popped out, is not also
  expanded: Maximise and Pop out collapse it, and a click on the tile of a popped-out session brings that window forward.
  Two attached terminals would each size the session to themselves.
- **Kept in one place.** The expanded tiles and their sizes are one state on the board (`board/expanded.ts`, pure), saved
  in the daemon's view state (`expandedTiles`) and taken back when the board opens.
- **xterm under the board's zoom.** xterm measures its cells with `measureText` and fits to the layout size, so its
  columns and rows are right at any zoom. Its mouse mapping divides the pointer's offset from the scaled on-screen box
  by unscaled cells, so `TerminalPane` wraps xterm's mouse service (`session/zoomed-mouse.ts`) to rescale each pointer
  about the terminal's origin by on-screen width ÷ `offsetWidth` first. Selection and mouse reports are right at any zoom.

**Update**:

- **Selection is React Flow's, with three changes.** A drag on empty board draws React Flow's marquee
  (`selectionOnDrag`, full containment); the board pans with Space held, the middle button or the wheel, or anywhere
  with the Hand. Shift is the multi-select key, and a Shift-marquee adds to what was selected (React Flow's own
  replaces it, so the board drops its deselect changes meanwhile). A click on one of several selected, without a drag,
  selects it alone. React Flow's own selection rectangle still drags a marquee's selection but is drawn invisibly; the
  board draws one box round any selection of two or more, labelled with what is in it (`SelectionBox`).
- **Undo is a pure history of states, applied through the board's own actions.** `editing/history.ts` keeps steps of
  before and after states by object key (an item or connector whole, a zone's layout, a tile's place), never commands;
  `editing/use-history.ts` records every change made in one task as one step, merges the saves of one typing or
  nudging, and on undo or redo puts each object back through the same actions the user's edits use (an item or
  connector deleted is made again under its own id, then given its `z`). The history is per window and in memory, at
  least 100 steps. Session actions are never recorded; a tile's place is.
- **Snapping happens in the node changes.** `useSnapping` sits between React Flow's position changes and the board
  (after the drag's pointer lag is put right), moving every dragged node by one shift so the box round them lines up with
  an edge or centre of something near it, or its corner with the grid. Guides draw in a `ViewportPortal`.
- **Copy and paste use the clipboard's events.** Copy and cut fill the clipboard with the selected items and the
  connectors between them under `application/x-agent-board+json` (and their text for other apps), from the DOM `copy`
  and `cut` events the Edit menu's roles send, so the menu and the keys share one path. A paste reads that type before
  images and links. Undo, redo, select all, duplicate and restacking are keydown shortcuts that cancel the event, which
  Chromium honours before the Edit menu's key equivalents.
- **An image's file outlives its item's delete by the sweep's grace** (`ImageStore.spare`), so undoing the delete can
  make the item again: the daemon refuses an image item whose file is gone.

**Update**:

- **Flow edges are a second React Flow edge type, `flow`**, drawn from the daemon's flow edges between two agents'
  tiles, from a square out port (`flow-out`) to a square in port (`flow-in`) that only agents' tiles have. A drag from
  one is told apart from a connector's by its handle, and read by `onConnectEnd` as connectors are. Each is labelled
  with what it carries (`final message`, `plan.md`) and its trigger's mark, and, while it holds a hand-off for its
  conditions, says what for under the label. Its rules are edited in the Edge rules panel, outside React Flow, which
  pans the board clear of itself when it opens.
- **Making and deleting a flow edge are undoable**, as connectors are: the undo history keeps the edge whole, and
  undoing a delete makes it again under its own id, with its rules but a fresh history.

**Update**:

- **A click opens the session window; Expand in place is a setting.** What a click on an agent's or shell tile does is
  the click setting (`board/click-opens.ts`, pure), kept in the daemon's view state (`clickOpens`): the session window
  by default, or the tile expanded in place. An external session's tile, having no session window,
  always expands, and an expanded tile clicked again only comes to the front. A double-click still opens the session
  window, the first click having already done what the setting says, so `OPENING_DOUBLE_CLICK_MS` still applies to an
  expanding click.
- **The session window steps through its group's sessions.** `windows/session-nav.ts` (pure) orders the sessions of the
  shown one's zone, or the loose ones, in board order (rows top to bottom, each left to right, a row taking tiles within
  `ROW_TOLERANCE` of its top), wrapping at the ends; sessions popped out into their own windows are left out. The window
  swaps what it shows rather than closing.

**Update**:

- **Nothing on the board tilts by itself; items turn only when the user turns them.** Tiles lost their random tilt and
  the drag lift's extra tilt, and have no rotate handle. A board item keeps an angle, `rotation` (degrees clockwise about
  its own centre, in [-180, 180), 0 by default), in its own column, kind-agnostic, beside its unrotated
  `x`, `y`, `width` and `height`. So zone membership (by its centre) and every saved place are unchanged by turning it.
- **The node stays the straight box; what is drawn in it turns.** `withRotation` wraps each item kind's node, connector
  handles included, in an `.item-rotor` turned by CSS `rotate`, and has React Flow measure the handles again as the
  angle changes, so connectors stay on the turned sides. A turned item's node takes no pointer outside what is drawn,
  and hides its resize handles, which would drag along its straight edges.
- **Layout uses the box round a turned item** (`boundsOnBoard`): snapping, the selection box, align and distribute, and
  the reflow round an expanded tile. Copy and paste keep the unrotated box and the angle.
- **A turn is saved once, as one undo step, when the pointer is let go;** meanwhile the angles are a live store
  (`LiveRotations`) the turned items read. A selection of several is turned by its box's handle, each item about its own
  centre.

**Update**:

- **A zone drags from anywhere on it but its buttons: its tab and its bare body.** Zone nodes have no `dragHandle`.
  React Flow draws a zone's tiles and items as nodes of their own beside it, not inside its element, so a press on one
  still moves only that, and the tab's chips and the resize handles are `nodrag`. A press that moves less than
  `DRAG_THRESHOLD` (4px) is a click, which selects the zone.
- **A marquee inside a zone starts with Shift held,** since a plain drag there moves the zone. It is React Flow's
  selection key: held, a press anywhere, on a node too, starts a marquee, which adds to the selection as on bare board.
- **A zone's tab fits inside it at any size.** The tab sits in a strip as wide as it may be (`.zone-tab-strip`, which
  lets presses through to the zone). `ZoneNode` lists the chips on the tab in one table, each with what ⋯ offers in
  its place, and `useZoneTabFold` measures the tab when the strip resizes or the chips or their text change (never on a
  mere drag). The least needed chips fold into ⋯ first (Tidy, Add issue, the tracker, Bind…, the default repo, New
  shell, New agent, then a clone's Cancel), each still reachable there: while a zone clones, when it has no ⋯ of its
  own, a ⋯ holding only what folded appears. Its name, and a clone's progress, are cut short with an ellipsis only once
  every chip has folded. A folded chip keeps the width it was last drawn at, so one whose text changes while folded may
  unfold a step early and fold again at once. Zoom is a transform, so the fold doesn't depend on it.
