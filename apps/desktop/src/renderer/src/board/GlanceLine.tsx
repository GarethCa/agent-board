import { useShrinkingLine } from './use-shrinking-line';

/**
 * A glance tile's line (what it is doing or asks) in its fixed box: the whole of it, its text a step smaller as it gets
 * longer (`useShrinkingLine`), clamped with its full text in the tooltip only past the smallest. With no line yet the box
 * stays, empty, so the tile doesn't move when one arrives.
 */
export function GlanceLine({ line, className }: { line: { text: string; command: boolean } | null; className: string }) {
  const shrink = useShrinkingLine();
  return (
    <span
      ref={shrink}
      className={`glance-line ${className}`}
      data-testid={line === null ? undefined : 'tile-line'}
      data-command={line?.command || undefined}
      title={line?.text}
    >
      {line?.text}
    </span>
  );
}
