/*
 * Theme packs: other projects' palettes, each a named family of light and dark themes. A pack is data and nothing else:
 * its palette below is turned into a full set of theme tokens (theme-pack-tokens.ts), written to the renderer's
 * theme-packs.css, and its themes join the registry (themes.ts), so they become choices in Settings › Appearance.
 *
 * Every pack credits its source, in the picker and in THIRD_PARTY.md. Values are the design mock's mapping of each
 * project's published hexes; a step a palette doesn't have (a second background, a terminal well) is derived by mixing
 * and marked so. The terminal
 * is dark in every theme, so a light theme borrows its dark sibling's well and ANSI colours.
 */

/** A palette's hues, named as the board's zone and paint colours are, each the palette's nearest. */
export interface PackHues {
  blue: string;
  teal: string;
  amber: string;
  pink: string;
  violet: string;
  cyan: string;
  red: string;
  lime: string;
}

/** A terminal: its well, its text and its 16 ANSI colours (black red green yellow blue magenta cyan white, then brights). */
export interface PackTerminal {
  well: string;
  ink: string;
  ansi: readonly string[];
}

/** What a theme pack's palette gives; every other token is derived from it, and nudged where it must read at AA. */
export interface PackPalette {
  /** The desk, a tile (anything raised), a panel inside one and a card's edge. */
  desk: string;
  tile: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  /** A field's label, a tag: between text and muted unless the palette has its own. */
  soft?: string;
  /** The palette's signature colour: links, the flow edges, a picked card. */
  accent: string;
  /** The accent as a fill under white text, where the palette has a darker step for it. */
  accentFill?: string;
  /** Running, waiting for you and failed. */
  ok: string;
  warn: string;
  fail: string;
  /** A state's text and its pill's fill, where the palette has its own steps for them. */
  inks?: Partial<Record<'running' | 'waiting' | 'failed', string>>;
  softs?: Partial<Record<'running' | 'waiting' | 'failed', string>>;
  hues: PackHues;
  term: PackTerminal;
}

export interface PackTheme {
  /** Its `data-theme` value. */
  id: string;
  /** What Settings › Appearance calls it. */
  name: string;
  scheme: 'light' | 'dark';
  /**
   * A choice of its own in the picker rather than its family's light or dark side: the family's extra variants for one
   * mode, such as Catppuccin's Frappé and Macchiato beside Mocha, taking the family's theme for the other mode. Without it a
   * family has at most one theme per mode.
   */
  ownChoice?: boolean;
  palette: PackPalette;
}

export interface ThemePack {
  /** What the Appearance setting saves when the family is picked; never changes once shipped. */
  id: string;
  /** The family's name in the picker. */
  family: string;
  /** Its attribution line, shown under the family in the picker. */
  credit: string;
  themes: readonly PackTheme[];
}

// Terminals. Catppuccin's, Dracula's (its spec), Solarized's and Gruvbox's are as published; the others map the
// palette's own hexes onto the 16 slots. Wells outside a palette are derived: Dracula, Nord, One and Steel.
const MOCHA = { well: '#11111b', ink: '#cdd6f4', ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8', '#585b70', '#f37799', '#89d88b', '#ebd391', '#74a8fc', '#f2aede', '#6bd7ca', '#bac2de'] };
const MACCHIATO = { well: '#181926', ink: '#cad3f5', ansi: ['#494d64', '#ed8796', '#a6da95', '#eed49f', '#8aadf4', '#f5bde6', '#8bd5ca', '#a5adcb', '#5b6078', '#ec7486', '#8ccf7f', '#e1c682', '#78a1f6', '#f2a9dd', '#63cbc0', '#b8c0e0'] };
const FRAPPE = { well: '#232634', ink: '#c6d0f5', ansi: ['#51576d', '#e78284', '#a6d189', '#e5c890', '#8caaee', '#f4b8e4', '#81c8be', '#a5adce', '#626880', '#e67172', '#8ec772', '#d9ba73', '#7b9ef0', '#f2a4db', '#5abfb5', '#b5bfe2'] };
const ROSE_PINE = { well: '#191724', ink: '#e0def4', ansi: ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'] };
const DRACULA = { well: '#191a21', ink: '#f8f8f2', ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'] };
const NORD = { well: '#242933', ink: '#d8dee9', ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'] };
const GRUVBOX = { well: '#1d2021', ink: '#ebdbb2', ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'] };
const SOLARIZED = { well: '#002b36', ink: '#839496', ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'] };
const TOKYO_NIGHT = { well: '#16161e', ink: '#a9b1d6', ansi: ['#414868', '#f7768e', '#73daca', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5', '#414868', '#f7768e', '#73daca', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'] };
const ONE = { well: '#1e2127', ink: '#abb2bf', ansi: ['#3f4451', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#be5046', '#98c379', '#d19a66', '#61afef', '#c678dd', '#56b6c2', '#ffffff'] };
const EVERFOREST = { well: '#232a2e', ink: '#d3c6aa', ansi: ['#475258', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa', '#7a8478', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa'] };
const KANAGAWA = { well: '#16161d', ink: '#dcd7ba', ansi: ['#2a2a37', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'] };
const CLEAR_SIGHT = { well: '#111111', ink: '#e8e8e8', ansi: ['#2a2a2a', '#d55e00', '#009e73', '#f0e442', '#56b4e9', '#cc79a7', '#7fd0e8', '#d0d0d0', '#6e6e6e', '#ef8a3c', '#3fc79a', '#f6ee8a', '#8fcdf2', '#e3a6c8', '#b0e2f2', '#ffffff'] };
const RADIX = { well: '#111110', ink: '#eeeeec', ansi: ['#3b3a37', '#ff9592', '#71d083', '#ffca16', '#70b8ff', '#e796f3', '#4ccce6', '#b5b3ad', '#62605b', '#ffd1d9', '#c2f0c2', '#ffe7b3', '#c2e6ff', '#f4d4f4', '#b6ecf7', '#eeeeec'] };
const STEEL = { well: '#0b0b0b', ink: '#f4f4f4', ansi: ['#393939', '#fa4d56', '#42be65', '#f1c21b', '#78a9ff', '#ff7eb6', '#33b1ff', '#c6c6c6', '#6f6f6f', '#ff8389', '#6fdc8c', '#fddc69', '#a6c8ff', '#ffafd2', '#82cfff', '#f4f4f4'] };

export const THEME_PACKS = [
  {
    id: 'catppuccin',
    family: 'Catppuccin',
    credit: 'Catppuccin · MIT · github.com/catppuccin/catppuccin',
    themes: [
      {
        id: 'catppuccin-latte',
        name: 'Catppuccin Latte',
        scheme: 'light',
        palette: {
          desk: '#e6e9ef', tile: '#eff1f5', panel: '#e6e9ef', border: '#ccd0da', text: '#4c4f69', muted: '#6c6f85',
          accent: '#1e66f5', ok: '#40a02b', warn: '#fe640b', fail: '#d20f39',
          hues: { blue: '#1e66f5', teal: '#179299', amber: '#df8e1d', pink: '#ea76cb', violet: '#8839ef', cyan: '#04a5e5', red: '#d20f39', lime: '#40a02b' },
          term: MOCHA,
        },
      },
      {
        id: 'catppuccin-frappe',
        ownChoice: true,
        name: 'Catppuccin Frappé',
        scheme: 'dark',
        palette: {
          desk: '#292c3c', tile: '#303446', panel: '#292c3c', border: '#414559', text: '#c6d0f5', muted: '#a5adce',
          accent: '#8caaee', ok: '#a6d189', warn: '#ef9f76', fail: '#e78284',
          hues: { blue: '#8caaee', teal: '#81c8be', amber: '#e5c890', pink: '#f4b8e4', violet: '#ca9ee6', cyan: '#99d1db', red: '#e78284', lime: '#a6d189' },
          term: FRAPPE,
        },
      },
      {
        id: 'catppuccin-macchiato',
        ownChoice: true,
        name: 'Catppuccin Macchiato',
        scheme: 'dark',
        palette: {
          desk: '#1e2030', tile: '#24273a', panel: '#1e2030', border: '#363a4f', text: '#cad3f5', muted: '#a5adcb',
          accent: '#8aadf4', ok: '#a6da95', warn: '#f5a97f', fail: '#ed8796',
          hues: { blue: '#8aadf4', teal: '#8bd5ca', amber: '#eed49f', pink: '#f5bde6', violet: '#c6a0f6', cyan: '#91d7e3', red: '#ed8796', lime: '#a6da95' },
          term: MACCHIATO,
        },
      },
      {
        id: 'catppuccin-mocha',
        name: 'Catppuccin Mocha',
        scheme: 'dark',
        palette: {
          desk: '#181825', tile: '#1e1e2e', panel: '#181825', border: '#313244', text: '#cdd6f4', muted: '#a6adc8',
          accent: '#89b4fa', ok: '#a6e3a1', warn: '#fab387', fail: '#f38ba8',
          hues: { blue: '#89b4fa', teal: '#94e2d5', amber: '#f9e2af', pink: '#f5c2e7', violet: '#cba6f7', cyan: '#89dceb', red: '#f38ba8', lime: '#a6e3a1' },
          term: MOCHA,
        },
      },
    ],
  },
  {
    id: 'rose-pine',
    family: 'Rosé Pine',
    credit: 'Rosé Pine · MIT · rosepinetheme.com',
    themes: [
      {
        id: 'rose-pine-dawn',
        name: 'Rosé Pine Dawn',
        scheme: 'light',
        // No green in the palette, so running is pine (light) or foam (dark).
        palette: {
          desk: '#f2e9e1', tile: '#fffaf3', panel: '#faf4ed', border: '#dfdad9', text: '#575279', muted: '#797593',
          accent: '#907aa9', ok: '#286983', warn: '#ea9d34', fail: '#b4637a',
          hues: { blue: '#286983', teal: '#56949f', amber: '#ea9d34', pink: '#d7827e', violet: '#907aa9', cyan: '#56949f', red: '#b4637a', lime: '#286983' },
          term: ROSE_PINE,
        },
      },
      {
        id: 'rose-pine',
        name: 'Rosé Pine',
        scheme: 'dark',
        palette: {
          desk: '#191724', tile: '#1f1d2e', panel: '#191724', border: '#403d52', text: '#e0def4', muted: '#908caa',
          accent: '#c4a7e7', ok: '#9ccfd8', warn: '#f6c177', fail: '#eb6f92',
          hues: { blue: '#31748f', teal: '#9ccfd8', amber: '#f6c177', pink: '#ebbcba', violet: '#c4a7e7', cyan: '#9ccfd8', red: '#eb6f92', lime: '#31748f' },
          term: ROSE_PINE,
        },
      },
    ],
  },
  {
    id: 'dracula',
    family: 'Dracula',
    // The OSS palette only (Dracula and Alucard in its README), never Dracula PRO's.
    credit: 'Dracula Theme · MIT · draculatheme.com (OSS palette)',
    themes: [
      {
        id: 'alucard',
        name: 'Alucard',
        scheme: 'light',
        // The OSS palette has one background: the desk and panel are mixed from it and its current line.
        palette: {
          desk: '#f0ecdb', tile: '#fffbeb', panel: '#f8f4e3', border: '#cfcfde', text: '#1f1f1f', muted: '#6c664b',
          accent: '#644ac9', ok: '#14710a', warn: '#a34d14', fail: '#cb3a2a',
          hues: { blue: '#644ac9', teal: '#14710a', amber: '#846e15', pink: '#a3144d', violet: '#644ac9', cyan: '#036a96', red: '#cb3a2a', lime: '#14710a' },
          term: DRACULA,
        },
      },
      {
        id: 'dracula',
        name: 'Dracula',
        scheme: 'dark',
        palette: {
          desk: '#21222c', tile: '#282a36', panel: '#21222c', border: '#44475a', text: '#f8f8f2', muted: '#6272a4',
          accent: '#bd93f9', ok: '#50fa7b', warn: '#ffb86c', fail: '#ff5555',
          hues: { blue: '#bd93f9', teal: '#50fa7b', amber: '#ffb86c', pink: '#ff79c6', violet: '#bd93f9', cyan: '#8be9fd', red: '#ff5555', lime: '#f1fa8c' },
          term: DRACULA,
        },
      },
    ],
  },
  {
    id: 'nord',
    family: 'Nord',
    credit: 'Nord by Sven Greb · MIT · nordtheme.com',
    themes: [
      {
        id: 'nord',
        name: 'Nord',
        scheme: 'dark',
        palette: {
          desk: '#2e3440', tile: '#3b4252', panel: '#2e3440', border: '#4c566a', text: '#eceff4', muted: '#d8dee9', soft: '#e5e9f0',
          accent: '#88c0d0', ok: '#a3be8c', warn: '#d08770', fail: '#bf616a',
          hues: { blue: '#5e81ac', teal: '#8fbcbb', amber: '#ebcb8b', pink: '#b48ead', violet: '#b48ead', cyan: '#88c0d0', red: '#bf616a', lime: '#a3be8c' },
          term: NORD,
        },
      },
    ],
  },
  {
    id: 'gruvbox',
    family: 'Gruvbox',
    credit: 'Gruvbox by morhetz · MIT/X11 · github.com/morhetz/gruvbox',
    themes: [
      {
        id: 'gruvbox-light',
        name: 'Gruvbox Light',
        scheme: 'light',
        // The light theme takes Gruvbox's faded accents, the dark one its bright ones.
        palette: {
          desk: '#f2e5bc', tile: '#fbf1c7', panel: '#f2e5bc', border: '#d5c4a1', text: '#3c3836', muted: '#7c6f64',
          accent: '#076678', ok: '#79740e', warn: '#af3a03', fail: '#9d0006',
          hues: { blue: '#076678', teal: '#427b58', amber: '#b57614', pink: '#8f3f71', violet: '#8f3f71', cyan: '#427b58', red: '#9d0006', lime: '#79740e' },
          term: GRUVBOX,
        },
      },
      {
        id: 'gruvbox-dark',
        name: 'Gruvbox Dark',
        scheme: 'dark',
        palette: {
          desk: '#1d2021', tile: '#282828', panel: '#32302f', border: '#504945', text: '#ebdbb2', muted: '#a89984',
          accent: '#83a598', ok: '#b8bb26', warn: '#fe8019', fail: '#fb4934',
          hues: { blue: '#83a598', teal: '#8ec07c', amber: '#fabd2f', pink: '#d3869b', violet: '#d3869b', cyan: '#8ec07c', red: '#fb4934', lime: '#b8bb26' },
          term: GRUVBOX,
        },
      },
    ],
  },
  {
    id: 'solarized',
    family: 'Solarized',
    credit: 'Solarized by Ethan Schoonover · MIT',
    themes: [
      {
        id: 'solarized-light',
        name: 'Solarized Light',
        scheme: 'light',
        palette: {
          desk: '#eee8d5', tile: '#fdf6e3', panel: '#eee8d5', border: '#93a1a1', text: '#586e75', muted: '#657b83',
          accent: '#268bd2', ok: '#859900', warn: '#cb4b16', fail: '#dc322f',
          hues: { blue: '#268bd2', teal: '#2aa198', amber: '#b58900', pink: '#d33682', violet: '#6c71c4', cyan: '#2aa198', red: '#dc322f', lime: '#859900' },
          term: SOLARIZED,
        },
      },
      {
        id: 'solarized-dark',
        name: 'Solarized Dark',
        scheme: 'dark',
        palette: {
          desk: '#002b36', tile: '#073642', panel: '#002b36', border: '#586e75', text: '#93a1a1', muted: '#839496',
          accent: '#268bd2', ok: '#859900', warn: '#cb4b16', fail: '#dc322f',
          hues: { blue: '#268bd2', teal: '#2aa198', amber: '#b58900', pink: '#d33682', violet: '#6c71c4', cyan: '#2aa198', red: '#dc322f', lime: '#859900' },
          term: SOLARIZED,
        },
      },
    ],
  },
  {
    id: 'tokyo-night',
    family: 'Tokyo Night',
    // enkia's original theme (MIT), not the Neovim port's Storm, Moon or Day.
    credit: 'Tokyo Night by enkia · MIT',
    themes: [
      {
        id: 'tokyo-night-light',
        name: 'Tokyo Night Light',
        scheme: 'light',
        // One background in the palette: the desk, panel and border are mixed from it and its text.
        palette: {
          desk: '#dadbe3', tile: '#e6e7ed', panel: '#e0e1e8', border: '#cacbd5', text: '#343b58', muted: '#6c6e75',
          accent: '#2959aa', ok: '#385f0d', warn: '#965027', fail: '#8c4351',
          hues: { blue: '#2959aa', teal: '#33635c', amber: '#8f5e15', pink: '#5a3e8e', violet: '#5a3e8e', cyan: '#0f4b6e', red: '#8c4351', lime: '#385f0d' },
          term: TOKYO_NIGHT,
        },
      },
      {
        id: 'tokyo-night',
        name: 'Tokyo Night',
        scheme: 'dark',
        palette: {
          desk: '#16161e', tile: '#1a1b26', panel: '#16161e', border: '#292e42', text: '#c0caf5', muted: '#9aa5ce',
          accent: '#7aa2f7', ok: '#9ece6a', warn: '#ff9e64', fail: '#f7768e',
          hues: { blue: '#7aa2f7', teal: '#73daca', amber: '#e0af68', pink: '#bb9af7', violet: '#bb9af7', cyan: '#7dcfff', red: '#f7768e', lime: '#9ece6a' },
          term: TOKYO_NIGHT,
        },
      },
    ],
  },
  {
    id: 'one',
    family: 'One',
    credit: 'One Dark / One Light, Atom project · MIT',
    themes: [
      {
        id: 'one-light',
        name: 'One Light',
        scheme: 'light',
        palette: {
          desk: '#eaeaeb', tile: '#fafafa', panel: '#f0f0f1', border: '#dbdbdc', text: '#383a42', muted: '#696c77',
          accent: '#4078f2', ok: '#50a14f', warn: '#986801', fail: '#e45649',
          hues: { blue: '#4078f2', teal: '#0184bc', amber: '#c18401', pink: '#a626a4', violet: '#a626a4', cyan: '#0184bc', red: '#e45649', lime: '#50a14f' },
          term: ONE,
        },
      },
      {
        id: 'one-dark',
        name: 'One Dark',
        scheme: 'dark',
        palette: {
          desk: '#21252b', tile: '#282c34', panel: '#21252b', border: '#3e4451', text: '#abb2bf', muted: '#828997',
          accent: '#61afef', ok: '#98c379', warn: '#d19a66', fail: '#e06c75',
          hues: { blue: '#61afef', teal: '#56b6c2', amber: '#e5c07b', pink: '#c678dd', violet: '#c678dd', cyan: '#56b6c2', red: '#e06c75', lime: '#98c379' },
          term: ONE,
        },
      },
    ],
  },
  {
    id: 'everforest',
    family: 'Everforest',
    credit: 'Everforest by sainnhe · MIT',
    themes: [
      {
        id: 'everforest-light',
        name: 'Everforest Light',
        scheme: 'light',
        palette: {
          desk: '#efebd4', tile: '#fdf6e3', panel: '#f4f0d9', border: '#e0dcc7', text: '#5c6a72', muted: '#829181',
          accent: '#3a94c5', ok: '#8da101', warn: '#f57d26', fail: '#f85552',
          hues: { blue: '#3a94c5', teal: '#35a77c', amber: '#dfa000', pink: '#df69ba', violet: '#df69ba', cyan: '#35a77c', red: '#f85552', lime: '#8da101' },
          term: EVERFOREST,
        },
      },
      {
        id: 'everforest-dark',
        name: 'Everforest Dark',
        scheme: 'dark',
        palette: {
          desk: '#232a2e', tile: '#2d353b', panel: '#343f44', border: '#475258', text: '#d3c6aa', muted: '#9da9a0',
          accent: '#7fbbb3', ok: '#a7c080', warn: '#e69875', fail: '#e67e80',
          hues: { blue: '#7fbbb3', teal: '#83c092', amber: '#dbbc7f', pink: '#d699b6', violet: '#d699b6', cyan: '#83c092', red: '#e67e80', lime: '#a7c080' },
          term: EVERFOREST,
        },
      },
    ],
  },
  {
    id: 'kanagawa',
    family: 'Kanagawa',
    credit: 'Kanagawa by rebelot · MIT',
    themes: [
      {
        id: 'kanagawa-lotus',
        name: 'Kanagawa Lotus',
        scheme: 'light',
        palette: {
          desk: '#e5ddb0', tile: '#f2ecbc', panel: '#e7dba0', border: '#d5cea3', text: '#545464', muted: '#716e61',
          accent: '#4d699b', ok: '#6f894e', warn: '#cc6d00', fail: '#c84053',
          hues: { blue: '#4d699b', teal: '#597b75', amber: '#de9800', pink: '#b35b79', violet: '#624c83', cyan: '#4e8ca2', red: '#c84053', lime: '#6f894e' },
          term: KANAGAWA,
        },
      },
      {
        id: 'kanagawa-wave',
        name: 'Kanagawa Wave',
        scheme: 'dark',
        palette: {
          desk: '#16161d', tile: '#1f1f28', panel: '#1a1a22', border: '#363646', text: '#dcd7ba', muted: '#c8c093',
          accent: '#7e9cd8', ok: '#98bb6c', warn: '#ffa066', fail: '#e46876',
          hues: { blue: '#7e9cd8', teal: '#7aa89f', amber: '#e6c384', pink: '#d27e99', violet: '#957fb8', cyan: '#7fb4ca', red: '#e46876', lime: '#98bb6c' },
          term: KANAGAWA,
        },
      },
    ],
  },
  {
    id: 'clear-sight',
    family: 'Clear Sight',
    // The colour-blind-safe pack: running (bluish green), waiting (orange) and failed (vermillion) stay apart for protan,
    // deutan and tritan vision, and every pill keeps its word. The neutrals and the ANSI brights are derived.
    credit: 'Colours: Okabe–Ito palette (Okabe & Ito, Color Universal Design)',
    themes: [
      {
        id: 'clear-sight-light',
        name: 'Clear Sight Light',
        scheme: 'light',
        palette: {
          desk: '#f3f3f1', tile: '#ffffff', panel: '#f9f9f8', border: '#dadad6', text: '#1a1a1a', muted: '#5e5e5e',
          accent: '#0072b2', ok: '#009e73', warn: '#e69f00', fail: '#d55e00',
          hues: { blue: '#0072b2', teal: '#009e73', amber: '#e69f00', pink: '#cc79a7', violet: '#cc79a7', cyan: '#56b4e9', red: '#d55e00', lime: '#f0e442' },
          term: CLEAR_SIGHT,
        },
      },
      {
        id: 'clear-sight-dark',
        name: 'Clear Sight Dark',
        scheme: 'dark',
        palette: {
          desk: '#141414', tile: '#1e1e1e', panel: '#191919', border: '#343434', text: '#eeeeee', muted: '#a9a9a9',
          accent: '#56b4e9', ok: '#009e73', warn: '#e69f00', fail: '#d55e00',
          hues: { blue: '#56b4e9', teal: '#009e73', amber: '#e69f00', pink: '#cc79a7', violet: '#cc79a7', cyan: '#56b4e9', red: '#d55e00', lime: '#f0e442' },
          term: CLEAR_SIGHT,
        },
      },
    ],
  },
  {
    id: 'sand-indigo',
    family: 'Sand & Indigo',
    // Radix's sand, indigo, grass, orange and red scales, with their own text (11, 12) and soft (3) steps.
    credit: 'Built on Radix Colors · MIT',
    themes: [
      {
        id: 'sand-indigo-light',
        name: 'Sand & Indigo Light',
        scheme: 'light',
        palette: {
          desk: '#f1f0ef', tile: '#fdfdfc', panel: '#f9f9f8', border: '#dad9d6', text: '#21201c', muted: '#63635e',
          accent: '#3a5bc7', accentFill: '#3e63dd', ok: '#46a758', warn: '#f76b15', fail: '#e5484d',
          inks: { running: '#2a7e3b', waiting: '#cc4e00', failed: '#ce2c31' },
          softs: { running: '#e9f6e9', waiting: '#ffefd6', failed: '#feebec' },
          hues: { blue: '#0090ff', teal: '#12a594', amber: '#ffc53d', pink: '#d6409f', violet: '#6e56cf', cyan: '#00a2c7', red: '#e5484d', lime: '#bdee63' },
          term: RADIX,
        },
      },
      {
        id: 'sand-indigo-dark',
        name: 'Sand & Indigo Dark',
        scheme: 'dark',
        palette: {
          desk: '#111110', tile: '#191918', panel: '#222221', border: '#3b3a37', text: '#eeeeec', muted: '#b5b3ad',
          accent: '#9eb1ff', accentFill: '#3e63dd', ok: '#46a758', warn: '#f76b15', fail: '#e5484d',
          inks: { running: '#71d083', waiting: '#ffa057', failed: '#ff9592' },
          softs: { running: '#1b2a1e', waiting: '#331e0b', failed: '#3b1219' },
          hues: { blue: '#0090ff', teal: '#12a594', amber: '#ffc53d', pink: '#d6409f', violet: '#6e56cf', cyan: '#00a2c7', red: '#e5484d', lime: '#bdee63' },
          term: RADIX,
        },
      },
    ],
  },
  {
    id: 'steel',
    family: 'Steel',
    // IBM Carbon's grey and blue 60 scales, under a neutral name: IBM's marks stay out of product names.
    credit: 'Colours from IBM Carbon · Apache-2.0',
    themes: [
      {
        id: 'steel-light',
        name: 'Steel Light',
        scheme: 'light',
        palette: {
          desk: '#f4f4f4', tile: '#ffffff', panel: '#f4f4f4', border: '#e0e0e0', text: '#161616', muted: '#525252',
          accent: '#0f62fe', ok: '#198038', warn: '#ba4e00', fail: '#da1e28',
          softs: { running: '#defbe6', waiting: '#fff2e8', failed: '#fff1f1' },
          hues: { blue: '#0f62fe', teal: '#007d79', amber: '#b28600', pink: '#d02670', violet: '#8a3ffc', cyan: '#0072c3', red: '#da1e28', lime: '#24a148' },
          term: STEEL,
        },
      },
      {
        id: 'steel-dark',
        name: 'Steel Dark',
        scheme: 'dark',
        palette: {
          desk: '#161616', tile: '#262626', panel: '#1f1f1f', border: '#393939', text: '#f4f4f4', muted: '#c6c6c6',
          accent: '#78a9ff', accentFill: '#0f62fe', ok: '#42be65', warn: '#ff832b', fail: '#ff8389',
          hues: { blue: '#4589ff', teal: '#08bdba', amber: '#f1c21b', pink: '#ee5396', violet: '#a56eff', cyan: '#33b1ff', red: '#fa4d56', lime: '#42be65' },
          term: STEEL,
        },
      },
    ],
  },
] as const satisfies readonly ThemePack[];

type PackThemeEntry = (typeof THEME_PACKS)[number]['themes'][number];

/** Every pack's themes, in the picker's order. */
export const PACK_THEMES: readonly PackThemeEntry[] = THEME_PACKS.flatMap((pack): readonly PackThemeEntry[] => pack.themes);
