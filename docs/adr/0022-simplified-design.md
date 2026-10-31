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
- **Theme packs wait.** The Simplified design has only its own light and dark looks. While it is on, the window shows the app's own theme in the picked mode (`data-theme` is `light` or `dark`), whatever theme choice Appearance holds; the pack comes back when it is off. Supporting packs under it would double the looks every flag-on screen is checked in.

## The docked pane

Needs you and the Captain open one docked pane, the Classic Captain panel's frame (its width, its drag handle, its place under the islands), each on its own side: Needs you on the list, the Captain on its chat. Under the flag the Needs-you pill is a plain toggle, not the inbox's popover. A click on the side that is open closes the pane; a click on the other button switches the side and keeps the pane open. The pane's side lives in `useMasterPanel()`, and ⌘⇧M always opens the Captain's. Open on a row of the list shows that agent and leaves the pane open, as it is docked, not a popover; the pane is the Captain's whatever it showed when the flag is turned off. The Captain's Watching and For you sections are not drawn under the flag; Classic's panel keeps them.

## What Classic never sees

- **No Classic baseline moves for flag-on work.** Every change made for the Simplified design keeps `pnpm test:visual` passing with no updated baseline for the default UI. Its own screenshots are named with a `simplified-` prefix, and are added, never replaced.
- **Classic-only paths stay as they are.** A component that renders differently under the flag keeps its Classic branch unchanged; one that only restyles needs no branch at all.
- **The setting itself is the one Classic change**: one row at the end of Settings.

## The technical layer

The Simplified design shows less by default: branches, models, pull requests, raw states, terminals and drawing tools sit behind one additive switch, Show technical details, which adds them back and never changes the layout. Every piece of flag-on work that shows something technical tags it as such, so that switch can add it, rather than deciding on its own whether to show it.

The creation toolbar is the exception for drawing tools and terminals: its Draw menu (a sticky note, text, a shape, a zone and Box select) shows with the switch off, as the chosen toolbar drawing has it, since it is the only button that makes a note or a zone. So is its terminal: the New agent button's menu adds a new terminal with the switch off too, as the chosen drawing has it, so a terminal is always a click away. Every tool's key works whatever the switch says.

- **The switch** is off by default and one per user. Main holds it in `technical.json`, beside `design.json` and for the same reason, and a new window's query carries it (`WINDOW_QUERY.technical`). It is in Settings › General › Design, under the Simplified design row, and in View › Show Technical Details, a checkbox with no key of its own (the obvious one, ⌥⌘D, is the system's Dock toggle). Main builds the menu bar again on every change to it or the design, so the item and the Settings switch follow each other and a pick in any window.
- **`data-technical` on the root** while the switch is on under the Simplified design (`renderer/src/technical.ts`). It is never set under Classic, whatever the switch says, so nothing Classic draws can tell it exists; Classic has no switch, and its View menu leaves the item out.
- **Tagging is one of two ways.** A technical element that only needs leaving out carries `data-technical-detail`, which `app.css` hides under the Simplified design while the root is unmarked. A component that renders something different, or a menu item that needs the layer and is disabled while it is off, reads `useTechnicalDetails()`, which is true under Classic and under the Simplified design only with the switch on (`shared/technical.ts`). Nothing reads the setting itself to decide what to show.
- **Showing it moves nothing untagged.** A hidden bit is out of the flow, so a tagged bit sits where its coming back moves nothing else: the end of a row, a line or a slot of its own. Where it can't, the component reserves the room itself and reads `useTechnicalDetails()` instead. The rule's `display: none !important` is meant to beat a component's own `display`, inline or not.

## Consequences

- Classic and the Simplified design share every component, so a fix to one reaches both, and nothing is built twice.
- Each component that renders differently carries a branch until Classic is retired or the Simplified design is dropped; `useSimplified()` finds them all.
- What the app measures in script follows the design as well as the theme: open terminals restyle and refit, a zone's tab measures its chips again and the colour rows are kept per theme and design. A text item's box is still measured when it is edited, so one made under the other design keeps its box until then.
- Its system fonts (SF Pro, SF Mono) aren't bundled, so its screenshots depend on the machine's fonts more than Classic's, whose fonts ship with the app.
