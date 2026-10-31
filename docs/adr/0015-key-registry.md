---
status: accepted
---
# Every key is an entry in one registry, and the keys added since sit behind one setting

The app's keys were matched in a dozen handlers, each testing `event.key` and the modifiers its own way, and written by hand in the help popover, the toolbar's tooltips, the context menu and the quick tour. The help popover had drifted: it listed 12 keys of more than 40. The keyboard-first work (the keyboard design page) adds many more keys over several changes, and the user asked that each can be turned off, leaving the app as it was.

## The registry

- **One list.** `apps/desktop/src/renderer/src/keys/registry.ts` holds an entry per action: an id (`section.action`, never renamed), a label, a cheat-sheet section, a scope (`board`, `tile`, `window`, `terminal-safe`: works with the focus in a terminal, or `dialog`: the menu, dialog or popover with the focus), a status, and its default chords.
- **Chords carry the modifier rule, not a string.** A chord's `mod` is `command` (⌘ on macOS, Ctrl elsewhere: the board's), `window` (⌘, or Ctrl+Shift where Ctrl and its keys are a terminal's) or `pane` (⌘⌥, or Ctrl+Shift+Alt); `otherKeys` overrides a chord off macOS where more than the rule changes (⇧⌘D is Ctrl+Shift+Alt+D, since Ctrl+Shift+D splits beside). A chord matches by `key` (what it types, for the board's letters) or by `code` (where the key is, for window chords, whose key Shift changes). Both the written form (`⌘⇧A`, `Ctrl+Shift+A`) and `pressed(id, event)` come from the chord, so a key and its hint can't disagree.
- **Handlers keep their guards.** `pressed` says only which key a press is. Whether the focus is typing, in an overlay, or on the board stays with each handler, which knows its surface.
- **Written-only entries.** A few are listed but matched elsewhere, because a press carries more than which key: the arrows' direction (nudge, pane focus), a tab's digit, the terminal's text size keys, ⇧↵ to the agent, ⌫ (React Flow's), a held modifier (⇧ while turning, ⌥ while drawing a hand-off, ⌘-click on a link), and the keys a dialog or list handles itself (↑↓, ↵, esc, ⌘↵). Every hint the app shows is still written from the registry. Their entries have no `key` or `code`, so `pressed` is never true for them. A change that moves one onto the registry gives it one.

## The setting

- **Status.** `today`: the key was in the app before the registry. `new`: added since. `fix`: an existing key changed to correct a bug (off macOS, for example, a window key that took a terminal's Ctrl key).
- **One gate.** "Extended keyboard shortcuts" (`keys/extended-shortcuts.ts`, view state `keyboard.extendedShortcuts`) is on by default. Off, `isActive` is false for every `new` entry, so `pressed` never matches one and the cheat sheet leaves it out; `today` and `fix` entries stay, the fixes because they correct bugs. A change that adds a key marks it `new` and needs nothing more to sit behind the setting; its tests cover both states.
- **Every window.** Each window reads the setting as it opens and again whenever it comes to the front, so a popped-out window follows a change made on the board without an IPC broadcast.

## Considered

- **Each new handler checks the setting itself.** Easy to forget, and the cheat sheet would need the same list again.
- **A keybindings file, or remapping now.** The design picks a read-only Settings › General › Keyboard first; a remap is a user layer over these defaults, later.
