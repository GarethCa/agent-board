# Third-party notices

agent-board's theme packs (Settings › Appearance) use colour palettes from the projects below. Each pack's colours are
in `apps/desktop/src/shared/theme-packs.ts`, credited in the picker, and turned into the app's theme tokens, some of
them lightened or darkened so text reads at WCAG AA. The names are the projects' own theme names, except where noted.

## Palettes under the MIT licence

| Theme pack | Project | Copyright |
| --- | --- | --- |
| Catppuccin Latte, Frappé, Macchiato, Mocha | [catppuccin/catppuccin](https://github.com/catppuccin/catppuccin) | Copyright (c) 2021 Catppuccin |
| Rosé Pine, Rosé Pine Dawn | [rose-pine/rose-pine-theme](https://github.com/rose-pine/rose-pine-theme) | Copyright (c) 2023 Rosé Pine |
| Dracula, Alucard (the open-source palette only) | [dracula/dracula-theme](https://github.com/dracula/dracula-theme) | Copyright (c) 2023 Dracula Theme |
| Nord | [nordtheme/nord](https://github.com/nordtheme/nord) | Copyright (c) 2016-present Sven Greb |
| Gruvbox Light, Gruvbox Dark | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) (MIT/X11, as its README states) | Copyright (c) morhetz |
| Solarized Light, Solarized Dark | [altercation/solarized](https://github.com/altercation/solarized) | Copyright (c) 2011 Ethan Schoonover |
| Tokyo Night, Tokyo Night Light | [tokyo-night/tokyo-night-vscode-theme](https://github.com/tokyo-night/tokyo-night-vscode-theme) | Copyright (c) 2018-present Enkia |
| One Dark, One Light | [atom/one-dark-syntax](https://github.com/atom/one-dark-syntax), [atom/one-light-syntax](https://github.com/atom/one-light-syntax) | Copyright (c) 2016 GitHub Inc. |
| Everforest Light, Everforest Dark | [sainnhe/everforest](https://github.com/sainnhe/everforest) | Copyright (c) 2019 sainnhe |
| Kanagawa Wave, Kanagawa Lotus | [rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim) | Copyright (c) 2021 Tommaso Laurenzi |
| Sand & Indigo Light, Sand & Indigo Dark (built on Radix Colors) | [radix-ui/colors](https://github.com/radix-ui/colors) | Copyright (c) 2021-2022 Modulz, Copyright (c) 2022-Present WorkOS |

Each of these is licensed as follows, with its own copyright line above:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Steel: colours from IBM Carbon, under the Apache License 2.0

The Steel theme pack uses colours from [carbon-design-system/carbon](https://github.com/carbon-design-system/carbon)
(`packages/colors`), Copyright IBM Corp., licensed under the Apache License, Version 2.0. It is named Steel, not after
any IBM product. agent-board changed them: it maps them onto its own theme tokens, and lightens or darkens some so text
reads at WCAG AA.

> Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
> the License. You may obtain a copy of the License at
>
> <http://www.apache.org/licenses/LICENSE-2.0>
>
> Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
> an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
> specific language governing permissions and limitations under the License.

The full text of the Apache License 2.0 is in [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).

## Clear Sight: the Okabe–Ito palette

The Clear Sight theme pack is built on the colour-blind-safe palette of Masataka Okabe and Kei Ito, from their Color
Universal Design guide (<https://jfly.uni-koeln.de/color/>), popularised by Bang Wong, "Points of view: Color
blindness", *Nature Methods* 8, 441 (2011). No licence is stated for its eight colours; agent-board credits the
authors as the guide asks. Its neutrals and terminal colours are agent-board's own.

## Fonts

The app bundles three typefaces through [Fontsource](https://fontsource.org) packages, all under the SIL Open Font
License, Version 1.1, whose full text is in [`licenses/OFL-1.1.txt`](licenses/OFL-1.1.txt). The copyright lines are the
ones in each package's `LICENSE` file.

| Typeface | Package | Copyright |
| --- | --- | --- |
| Bricolage Grotesque | `@fontsource-variable/bricolage-grotesque` | Copyright 2022 The Bricolage Grotesque Project Authors (<https://github.com/ateliertriay/bricolage>) |
| JetBrains Mono | `@fontsource-variable/jetbrains-mono` | Copyright 2020 The JetBrains Mono Project Authors (<https://github.com/JetBrains/JetBrainsMono>) |
| Caveat | `@fontsource/caveat` | Copyright 2014 The Caveat Project Authors (<https://github.com/googlefonts/caveat>) |

### DejaVu, in the visual tests only

The visual-regression spec renders with DejaVu Sans, DejaVu Sans Bold and DejaVu Sans Mono
(<https://dejavu-fonts.github.io/>, version 2.37), subset to the glyphs the app shows and stored in
`apps/desktop/e2e/fonts/`. They are not part of the shipped app. They are under the Bitstream Vera licence:

> Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is a trademark of Bitstream, Inc.
> DejaVu changes are in public domain.

The licence text is in [`apps/desktop/e2e/fonts/LICENSE.txt`](apps/desktop/e2e/fonts/LICENSE.txt).
