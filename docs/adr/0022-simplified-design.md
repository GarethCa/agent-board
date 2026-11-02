---
status: accepted
---
# The Simplified design is a flag over the same components

The Simplified design is a calmer, native-looking design for the app: SF Pro, system greys, the accent on controls only, orange only for Needs you and red only for Problem, a plain desk, a hairline and one soft shadow. It is built beside today's design, Classic, which stays the default until the Simplified one is finished and chosen. We build it as a flag over the same components rather than as a second set of them: one Button, one tile and one session window, each restyled by tokens and, where it must, rendering differently.

## The setting

- **Settings › General › Design › Simplified design** (marked Preview while it is built) turns it on. It is one per user, not per board.
- **Main holds it**, in `design.json` in the app's data folder, beside `appearance.json` and for the same reason: it is read before the first window opens, so no window flashes the other design. A new window's query carries it (`WINDOW_QUERY.design`), and its background is the Simplified desk when it is on (`shared/design.ts`).
- **Every window follows a pick at once**, with no reload: main sends it to every window (`design:changed`), as it does an Appearance pick.

## The flag

- **`data-design='simplified'` on the root** while it is on, set before the first paint (`renderer/src/design.ts`). Under Classic the attribute is absent, not `classic`, so no Classic selector can match it by accident.
- **Restyling is tokens.** Two blocks at the end of `tokens.css`, `:root[data-design='simplified']` and `:root[data-design='simplified'][data-theme='dark']`, set the Simplified values of tokens Classic already defines. They add no token of their own, and every colour the light block writes, the dark one writes too (`tokens.test.ts`). Components keep reading the same role tokens, so most of the work is in these blocks.
- **Rendering differently is `useSimplified()`**, for the components that must show something else (a different control, fewer parts), not a different look. It reads the root's attribute, so it agrees with the styles in every window.
- **Connections keep today's rails.** Rails, their tokens and captions are restyled by the rail tokens in these two blocks (neutral greys, the accent only on a selection, orange for a hand-off waiting on the user, red for one that failed), with the same shapes, routes and **Show connections** modes. A token under the flag has no Send button: a waiting hand-off is sent from its Edge rules.
- **Theme packs carry through.** The theme picked in Appearance shows under the Simplified design as under Classic: `data-theme` is the theme's id under either design, so a pack, its accent and a pick in any window apply at once. Over the app's own themes the design is its two blocks above. Over a pack it is a block of its own per pack theme, `:root[data-design='simplified'][data-theme='<id>']`, made with the pack's Classic block in `theme-packs.css` (`shared/theme-pack-tokens.ts`): it sets every token the design's blocks set in the pack's mode, so it outranks both them and the pack's Classic block. It keeps the design's shapes, type, shadows and aliases, and takes each colour from the pack's own tokens, but for two drawn the design's way: its rails are the pack's muted text faded into its desk, as its own greys are, and its waiting orange is the pack's that reads as text. A new window opens on the pack's desk (`deskFor`). Every pack maps: each meets the contrast checks every look is held to (`tokens.test.ts`), so none falls back to the design's own palette or its accent alone.

## The docked pane

Needs you and the Captain open one docked pane, the Classic Captain panel's frame (its width, its drag handle, its place under the islands), each on its own side: Needs you on the list, the Captain on its chat. Under the flag the Needs-you pill is a plain toggle, not the inbox's popover. A click on the side that is open closes the pane; a click on the other button switches the side and keeps the pane open. The pane's side lives in `useMasterPanel()`, and ⌘⇧M always opens the Captain's. Open on a row of the list shows that agent and leaves the pane open, as it is docked, not a popover; the pane is the Captain's whatever it showed when the flag is turned off. The Captain's Watching and For you sections are not drawn under the flag; Classic's panel keeps them.

**Since you last looked** sits under the list on the Needs-you side, and is not drawn on the Captain's side or under Classic. It holds only things that need nothing from the user (what needs them is the list above it): **Done**, the agents that said their work finished (`workFinishedAt`) since the last look, from the app's own record and so always true; and **Up next**, the Captain's own status line (`set_status`), shown only if it wrote it after the last look and is live. The app never writes either line itself, and with nothing to report the card is not drawn. "The last look" is when the list was last on screen, kept in the renderer's storage for every window (`useSinceLastLooked`); it is stamped when the list opens, when it goes and when the window unloads, and the card holds the look before that one still while the list stays up. **Mark as seen** moves it to now. A first look ever shows nothing. Done lists only agents still on the board and still finished: one closed after it finished, or prompted again, is gone from it. An agent waiting at its prompt under "every agent waiting" is Done, not an ask; only a question, plan, permission or flag keeps it out. It never answers, approves or nudges anything: a row only opens the agent.

## The composer

Under the flag the composer's `>` prompt is a **+** menu, its Send is a round arrow button and its hint line is gone (`Composer.tsx` renders the Classic tree unchanged when the flag is off). The menu holds **Attach an image…** (a picker feeding the same path as a paste), **Summarise the conversation so far** and **Change model…**. The two commands are *typed into the field* (`/compact`, and `/model` with a space after it) for the user to send with Enter, never sent by the app, and wait for an empty field so a draft is never swallowed. The empty field says a sentence for the state the agent is in (`composerPlaceholder`): "Reply…" while it waits on the user, then paused ("sending wakes it"), rate-limited ("your message will wait"), queued until it is up, or the reason the field is off. Enter, Shift+Enter and Option+Enter stay as they are.

## Questions and plans in the pane

Under the flag a question or plan the agent waits on shows above its pane's composer (`PaneDecision.tsx`), in the chat's views, using the same answering as the Needs you inbox (`useAskAnswer`, `PlanDecisionBar`). A question is "‹agent› asks", then a numbered row per choice (keys 1–9 while the frame has focus) and, when it takes words, a "Something else…" reply; a plan is "Plan vN", its title and Read the plan ›, then its comments and Reject · Request changes · Approve, Approve trailing and also pressed with ⌘↵. As it shows, the card takes the keyboard (a question's card itself, so Return never answers; a plan's comments field), unless the user is typing in a field such as the composer or a terminal, whose keys stay theirs. **Decide later** (Esc while the card has focus; Esc in the composer stays the draft's) only puts it off: it stays pending, in Needs you and on its tile, a line above the composer brings it back, and a new question or plan version shows again; the window stays open. What is put off stays put off while the app runs, across closing the window or changing its view. The composer stays beneath it, so a draft is never lost. One decision shows at a time (a question, then a plan; putting off the first shows the next); permission prompts stay in the terminal and the inbox. Classic keeps its chat line and the board's card.

## Agent notes

Under the flag a note an agent writes is drawn as Classic draws it (`AgentNoteFace` has one tree for both designs): its zone-coloured dashed card under the **Note · ‹agent›** tab, which selects the agent's tile and brings it into view while the tile is on the board. There is no coloured stripe down its side, and a note whose agent has no known name (in either design) has a tab that reads just **Note**: never a "by …" or an empty name. The card has one look, so Classic's **Agent notes** setting is not drawn under the flag (its section and search hits go with it) and a saved terminal look is not used. Stickies are not touched: their ink, link and lift are pinned to Classic's values in the flag's two token blocks (`--sticky-other-ink`, `--sticky-link`, `--sticky-shadow`), so the shared `--text`, `--accent` and `--shadow-tile` don't move them.

## The inspector under Classic

The inspector is offered to Classic too, as its **Agent sidebar** setting: Settings › Agents › Sidebar, **Simple** or **Full**. Full, today's details strip, is the default, so Classic is unchanged until Simple is picked. Under the Simplified design the sidebar is always Simple and the setting is not drawn (its section and search hits go with it), as the Agent notes setting is not.

- **Kept in the view state** (`agentSidebar`), with the board's other view settings, so every window follows a pick at once and an agent window open as it is picked swaps its sidebar there and then; the choice is read with the design (`useAgentSidebar()`), never on its own.
- **One inspector.** The same component in Classic's tokens: its CSS reads role tokens only. Its width, handle and hiding below the least are the Simplified design's, and whether it is shown and its folds are open are shared with it.
- **Classic's header gets the details toggle only while the sidebar is Simple.** The inspector has no rail to bring it back, so the header gains the Simplified header's toggle; with Full the header is as it was. Picking Simple shows the inspector rather than leaving it behind the toggle.
- **Classic's controls stay a click away.** Classic's header has no Stop, Wake or ⋯ of the agent's, so under Classic the inspector's More details fold ends with the strip's Controls and Panes rows: Interrupt, Pause or Wake, Stop, and splitting the tab. Technical details is always drawn under Classic, which has no switch, and it is a closed fold.
- **Expanded tiles, shell windows, external sessions and any session window with no agent keep the details strip** under either choice.

## What Classic never sees

- **No Classic baseline moves for flag-on work.** Every change made for the Simplified design keeps `pnpm test:visual` passing with no updated baseline for the default UI. Its own screenshots are named with a `simplified-` prefix, and are added, never replaced.
- **Classic-only paths stay as they are.** A component that renders differently under the flag keeps its Classic branch unchanged; one that only restyles needs no branch at all.
- **The setting itself is the one Classic change**: one row at the end of Settings. The Agent sidebar setting is Classic's own, with Full, its old drawing, as its default.

## The technical layer

The Simplified design shows less by default: branches, models, pull requests, raw states, terminals and drawing tools sit behind one additive switch, Show technical details, which adds them back and never changes the layout. Every piece of flag-on work that shows something technical tags it as such, so that switch can add it, rather than deciding on its own whether to show it.

The creation toolbar is the exception for drawing tools and terminals: its Draw menu (a sticky note, text, a shape and a zone) shows with the switch off, as the chosen toolbar drawing has it, since it is the only button that makes a note or a zone. So is its terminal: the New agent button's menu adds a new terminal with the switch off too, as the chosen drawing has it, so a terminal is always a click away. Every tool's key works whatever the switch says.

An agent's inspector is the exception for pull requests: its work lists each pull request, with its checks, or says there is none yet, with the switch off, as the chosen sidebar drawing has it, so an agent's open changes are never hidden. Its branch, folder, AI and model stay behind the switch, in its Technical details fold.

- **The switch** is off by default and one per user. Main holds it in `technical.json`, beside `design.json` and for the same reason, and a new window's query carries it (`WINDOW_QUERY.technical`). It is in Settings › General › Design, under the Simplified design row, and in View › Show Technical Details, a checkbox with no key of its own (the obvious one, ⌥⌘D, is the system's Dock toggle). Main builds the menu bar again on every change to it or the design, so the item and the Settings switch follow each other and a pick in any window.
- **`data-technical` on the root** while the switch is on under the Simplified design (`renderer/src/technical.ts`). It is never set under Classic, whatever the switch says, so nothing Classic draws can tell it exists; Classic has no switch, and its View menu leaves the item out.
- **Tagging is one of two ways.** A technical element that only needs leaving out carries `data-technical-detail`, which `app.css` hides under the Simplified design while the root is unmarked. A component that renders something different, or a menu item that needs the layer and is disabled while it is off, reads `useTechnicalDetails()`, which is true under Classic and under the Simplified design only with the switch on (`shared/technical.ts`). Nothing reads the setting itself to decide what to show.
- **Showing it moves nothing untagged.** A hidden bit is out of the flow, so a tagged bit sits where its coming back moves nothing else: the end of a row, a line or a slot of its own. Where it can't, the component reserves the room itself and reads `useTechnicalDetails()` instead. The rule's `display: none !important` is meant to beat a component's own `display`, inline or not.

## Consequences

- Classic and the Simplified design share every component, so a fix to one reaches both, and nothing is built twice.
- Each component that renders differently carries a branch until Classic is retired or the Simplified design is dropped; `useSimplified()` finds them all.
- What the app measures in script follows the design as well as the theme: open terminals restyle and refit, a zone's tab measures its chips again and the colour rows are kept per theme and design. A text item's box is still measured when it is edited, so one made under the other design keeps its box until then.
- Its system fonts (SF Pro, SF Mono) aren't bundled, so its screenshots depend on the machine's fonts more than Classic's, whose fonts ship with the app.
