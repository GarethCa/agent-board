---
status: accepted
---
# An in-repo design system on Radix primitives and lucide icons

The renderer's controls live in `apps/desktop/src/renderer/src/ui/`: our own components, with our own look (`ui/ui.css`, on the tokens in `tokens.css`), and no UI kit. The look is the maintainer's "Soft workbench" pick: an 8px radius, soft fills and shadows, and an accent-blue primary action. The fonts are Bricolage Grotesque for the UI, JetBrains Mono for code, branches and keys, and Caveat for sticky notes.

Behaviour that is hard to get right is borrowed from headless Radix primitives, each used by one component:

| Package | Used by | What it brings |
| --- | --- | --- |
| `@radix-ui/react-dialog` | `Dialog` | Focus trap, Esc, focus returned to the opener, scroll lock, the rest of the page made inert |
| `@radix-ui/react-dropdown-menu` | `Menu` | The WAI-ARIA menu button: arrow keys, typeahead, Home/End, Esc, focus return |
| `@radix-ui/react-popover` | `Popover` | Positioning that stays on screen, dismiss on Esc or a click elsewhere |
| `@radix-ui/react-tooltip` | `Tooltip` | Hover and focus delays shared across the app, positioning |

Radix ships no styles, so it decides nothing about the look. The rest of the primitives (Button, IconButton, Chip, the form controls, Badge, Tag, StatusPill, Kbd, Toast, EmptyState, and later the chrome's Island, ToolButton and Section) are plain elements and need no library.

The app's parents open a dialog by mounting it, so Radix has no trigger to give focus back to. `Dialog` remembers what had focus when it opened (for a menu's row, the menu's button) and focuses it again when it closes.

Icons come from `lucide-react`, imported one by one so the build tree-shakes them. The only drawn glyphs are the harness marks (`board/HarnessMark.tsx`, stand-ins until the vendors' marks land), the characters, and the samples on a text item's or shape's bar (a stroke's weight, a shape's outline), which show the item's own style as a swatch shows its colour.

Fonts come from the Fontsource packages (`@fontsource-variable/bricolage-grotesque`, `@fontsource-variable/jetbrains-mono`, `@fontsource/caveat`). Vite bundles their files into the app, so they load from `'self'` under the renderer's Content-Security-Policy and work offline. Google Fonts would need a CSP exception and the network.

## Considered options

- **A styled kit** (MUI, Chakra, Mantine): rejected. Its look would fight the Workbench tokens, and it is far more code than we need.
- **Hand-rolled behaviour only**: rejected for dialogs and menus. Our own `MenuButton` worked, but focus traps, typeahead and inert backgrounds are easy to get subtly wrong, and Radix is small and unstyled.
- **Radix's context menu**: not used. The board's right-click menu is the `ContextMenu` primitive, Radix's dropdown menu opened at the pointer, so the board's menus share one primitive and one look.

## Consequences

- Every new control uses a primitive from `ui/`, and every colour comes through a token. `tokens.test.ts` fails on a raw colour anywhere outside `tokens.css` (and `theme-packs.css`, which it generates from the theme packs' palettes), and on a raw value in the properties that take spacing, radius, type, shadow, filter, motion or a layer (its list is in `docs/theme-tokens.md`). Layout geometry, such as a checkbox tick's size or a switch knob's inset, is out of its scope.
- The chrome's controls show the designed `Tooltip`. A tile's buttons keep the native `title` instead: the board can hold hundreds of tiles, and a Radix tooltip per button would cost every pan frame.
- The component gallery (`#gallery`, `ui/ComponentGallery.tsx`) shows every primitive in every state, and `e2e/visual.spec.ts` guards it with screenshots in the bundled fonts. A `data-preview` attribute holds a control in its hover, active or focus state so the shots are still. The route is reachable in production builds too, as the character gallery was before it: the visual tests drive the built app.
- Dialogs are modal: while one is open, the board behind it takes no clicks. The toast region is a live region, which Radix leaves readable while a dialog hides the rest of the page, and a click on a toast doesn't dismiss the dialog. The dialog's focus trap still keeps a toast's buttons from the keyboard until it closes.
- Fontsource's stylesheets list a `.woff` beside each `.woff2`, so the build carries both; Electron only ever loads the `.woff2`.
- Dependencies are pinned to exact versions at least two weeks old when added.
