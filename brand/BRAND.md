# agent-board brand

**Decided:** the logo is **"Zone with a resident, sitting on the tile"**: a project zone with its tab, a white tile, and a small robot resident sitting on the tile with its legs dangling. Its antenna orb is the status light.

- **Default colourway:** desk blue (`blue`).
- **Dark mode:** `dark`.
- **Optional:** the other colourways (`green`, `plum`, `warm`, `bold`) are not used by default. Expose them later as a user-selectable app-icon setting.

The source of truth is `svg/`. Everything in `png/` is generated from it. If the mark changes, regenerate; don't hand-edit PNGs.

## Files and where they go

| File | Use |
|---|---|
| `svg/mark.svg` | Master mark: desk blue, needs-you state. In-app header (≈30 px), About window, launch screen. |
| `svg/mark-dark.svg` | Same mark in the dark colourway, for dark theme surfaces. |
| `svg/mark-plain.svg` | The mark without its background square. Use on the board's desk background: empty state, README hero. |
| `svg/mark-{way}-{state}.svg` | Every colourway × state. `way` is blue, green, plum, warm, bold or dark. `state` is needs, working or quiet. |
| `svg/favicon.svg` | Simplified build for ≤48 px: no face, no legs, no progress bar. Use for the browser favicon and the tray at 1×. |
| `svg/menubar-template.svg` | One-colour (black on transparent) macOS menu-bar **template image**. |
| `svg/avatar.svg` | Square, no rounded corners. For GitHub, Linear and Slack avatars, which crop it themselves. |
| `png/app-icon/icon-{16…1024}.png` | App icon, full bleed. Feed `icon-1024.png` to the shell's icon generator (e.g. `electron-builder`, `tauri icon`). |
| `png/app-icon/icon-1024-macos-padded.png` | 1024 canvas with the art at 824 px, centred, with a soft shadow, following the macOS icon grid. Prefer this for the macOS `.icns`. |
| `png/app-icon/icon-dark-1024.png` | Dark-colourway icon, for when the OS supports per-appearance icons. |
| `png/dock-states/dock-{blue,dark}-{needs,working,quiet}-1024.png` | Runtime dock icon swaps (see **States**). |
| `png/favicon/favicon-{16,32,48}.png`, `favicon.ico` | Browser favicons. 180 is the apple-touch-icon, and 192/512 are for a web manifest. |
| `png/menubar/menubarTemplate.png`, `@2x` | Menu-bar icon at 18 and 36 px. Mark it as a template image so macOS tints it for light and dark bars. |
| `png/github/avatar-500.png` | GitHub org or app avatar. |
| `png/github/social-preview-1280x640.png` | Upload in the repo's Settings › Social preview. |
| `png/github/readme-hero.png` | Top of `README.md`. |
| `png/lockup-horizontal.png` | Mark plus wordmark, for docs and slides. |
| `png/colourways/*-512.png` | Previews for a future icon picker. |
| `cli-banner.txt` | Printed by `agent-board daemon` on start. |

## States (the mark is alive)

The resident and orb reflect overall app state. Use the same rule everywhere: dock icon, menu-bar dot, tray tooltip.

| State | When | Resident | Orb | Progress bar on tile |
|---|---|---|---|---|
| `needs` | ≥1 agent waiting for input or permission | hand up, mouth open | orange `#C2410C` with glow ring | short |
| `working` | ≥1 agent running, none waiting | eyes down at the tile, arm down | accent colour | medium |
| `quiet` | nothing running | eyes closed, "z" | grey `#B5B2AA` | full |

- **Dock:** swap to `dock-<way>-<state>-1024.png` and set the system badge to the number of agents waiting.
- **Menu bar:** keep the template icon, and draw a small red dot (`#E5484D`) next to it when the state is `needs`.
- **Motion (later):** a gentle 2-frame bob of the raised hand in `needs`, and the progress bar sweeping in `working`. Respect the OS "reduce motion" setting.

## Geometry (64 × 64 viewBox)

- **Background square:** `rx 15`.
- **Zone:** `x5 y16 w54 h42 rx9`, 3 px stroke.
- **Tab:** `x10 y10 w18 h10 rx3`.
- **Resident:** `x29 y14 w18 h23 rx9`.
- **Tile:** `x11 y34 w42 h17 rx4`.
- **Antenna orb:** centre `38,8.5`, r 2.8. It sits **above** the zone, so the status light stays visible even at 16 px.
- **Outline width:** 2.5 (ink `#1C1C1E`). Below 48 px, switch to `favicon.svg`, which uses 4-px outlines and drops the detail.

## Colour tokens (blue / dark)

| Token | blue | dark |
|---|---|---|
| background | `#EEEDE8` | `#1C1C1E` |
| zone fill | `#E3E7F3` | `#222A3A` |
| zone stroke, tab, accent | `#2347B8` | `#8FB1FF` |
| resident | `#FBE1D0` | `#FBE1D0` |
| cheeks | `#F08F7A` @ 70% | same |
| tile | `#FFFFFF` | `#2C2C2E` |
| ink (outlines) | `#1C1C1E` | `#F4F1E8` |
| eyes | `#1C1C1E` | `#1C1C1E` |
| orb, needs | `#C2410C` (glow `#F4A26B`) | `#FF8A3D` (glow `#FFB27A`) |

These match the app's "Workbench" theme. The desk is `#EEEDE8`, the waiting orange is `#C2410C`, and the accent blue is `#2347B8`.

## Type

- **Wordmark:** `agent-board`, all lowercase, Bricolage Grotesque ExtraBold (800), letter-spacing −0.02 to −0.03em.
- **App UI:** Bricolage Grotesque 400/600/700.
- **Code:** JetBrains Mono.
- Both fonts are on Google Fonts and Fontsource under the OFL. Bundle them with the app instead of loading them from a CDN.

## Rules

- Don't recolour individual parts outside the defined colourways, and don't add a gradient or shadow to the mark itself. The macOS padded icon's shadow is the only exception.
- Keep the resident sitting on the tile. Other poses (hand-off, waving on the zone wall) are for illustrations and empty states, not the logo.
- The name may still change. Keep the wordmark as a single text string (`APP_NAME`) so a rename doesn't touch the mark.
