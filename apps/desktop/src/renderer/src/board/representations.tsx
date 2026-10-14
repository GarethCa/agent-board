import { createContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { HybridTile } from './HybridTile';
import type { TileProps } from './tile';

/** Tile components by style. Hybrid is required: it draws any style the registry does not know. */
export type TileRegistry = { readonly hybrid: ComponentType<TileProps> } & Readonly<
  Record<string, ComponentType<TileProps>>
>;

/**
 * The representation registry (ADR-0003): one tile component per style. v1 ships only Hybrid; Character, Token and
 * Plain tile register here when they land.
 */
export const REPRESENTATIONS = {
  hybrid: HybridTile,
} satisfies TileRegistry;

export type Representation = keyof typeof REPRESENTATIONS;

export const DEFAULT_REPRESENTATION: Representation = 'hybrid';

/**
 * The tile component for `style`, or Hybrid for a style the registry does not know. Styles are plain strings here
 * because a tile's style may come from a newer build that has more of them.
 */
export function tileComponentFor(style: string, registry: TileRegistry = REPRESENTATIONS): ComponentType<TileProps> {
  return Object.hasOwn(registry, style) ? registry[style]! : registry[DEFAULT_REPRESENTATION];
}

interface RepresentationSettings {
  /** The board-wide style; a tile's own `style` overrides it. */
  style: string;
  registry: TileRegistry;
}

export const RepresentationContext = createContext<RepresentationSettings>({
  style: DEFAULT_REPRESENTATION,
  registry: REPRESENTATIONS,
});

/** Sets the board-wide style, and the registry it is looked up in, for the tiles below it. */
export function RepresentationProvider({
  style,
  registry = REPRESENTATIONS,
  children,
}: {
  style: string;
  registry?: TileRegistry;
  children?: ReactNode;
}) {
  // Memoised: a new value object would re-render every tile on the board.
  const value = useMemo(() => ({ style, registry }), [style, registry]);
  return <RepresentationContext value={value}>{children}</RepresentationContext>;
}
