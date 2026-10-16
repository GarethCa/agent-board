import type { ShapeType } from '@agent-board/daemon/protocol';
import { SHAPES } from './catalogue';
import type { ShapePart } from './geometry';

/**
 * The parts of `shape` drawn in a box `width` by `height`, inside a line `strokeWidth` px wide, in the `--shape-fill` and
 * `--shape-stroke` of the element around it. `icon` adds the detail drawn only on a picker's button.
 */
export function ShapeParts({
  shape,
  width,
  height,
  strokeWidth: stroke,
  dashed = false,
  icon = false,
}: {
  shape: ShapeType;
  width: number;
  height: number;
  strokeWidth: number;
  dashed?: boolean;
  icon?: boolean;
}) {
  const inset = stroke / 2;
  const parts = SHAPES[shape].draw({ x: inset, y: inset, width: Math.max(0, width - stroke), height: Math.max(0, height - stroke) });
  const dash = `${Math.max(stroke, 1) * 3} ${Math.max(stroke, 1) * 2}`;
  return (
    <g strokeWidth={stroke} strokeLinejoin="round">
      {parts
        .filter((part) => icon || part.iconOnly !== true)
        .map((part, index) => (
          <Part key={index} part={part} dash={part.dashed === true || (dashed && part.ink !== 'solid') ? dash : undefined} />
        ))}
    </g>
  );
}

function Part({ part, dash }: { part: ShapePart; dash: string | undefined }) {
  const paint = {
    fill: part.ink === 'shape' ? 'var(--shape-fill)' : part.ink === 'solid' ? 'var(--shape-stroke)' : 'none',
    stroke: part.ink === 'solid' ? 'none' : 'var(--shape-stroke)',
    strokeDasharray: dash,
    strokeLinecap: part.ink === 'line' ? ('round' as const) : undefined,
    opacity: part.opacity,
  };
  switch (part.el) {
    case 'rect':
      return (
        <rect
          {...paint}
          className={part.round === true ? 'shape-rounded' : undefined}
          x={part.x}
          y={part.y}
          width={Math.max(0, part.width)}
          height={Math.max(0, part.height)}
          rx={part.rx}
        />
      );
    case 'ellipse':
      return <ellipse {...paint} cx={part.cx} cy={part.cy} rx={Math.max(0, part.rx)} ry={Math.max(0, part.ry)} />;
    case 'path':
      return <path {...paint} d={part.d} />;
  }
}

/** The largest box of `shape`'s own proportions (its size when placed) that fits `room`: how a picker's button draws it. */
export function iconSize(shape: ShapeType, room: { width: number; height: number }) {
  const { width, height } = SHAPES[shape].size;
  const scale = Math.min(room.width / width, room.height / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

const ICON_ROOM = { width: 28, height: 22 };

/** `shape` as a picker's button or the Shape tool's button draws it: in the theme's raised fill and soft stroke. */
export function ShapeIcon({ shape, room = ICON_ROOM }: { shape: ShapeType; room?: { width: number; height: number } }) {
  const { width, height } = iconSize(shape, room);
  return (
    <svg className="shape-icon" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <ShapeParts shape={shape} width={width} height={height} strokeWidth={1.4} icon />
    </svg>
  );
}
