import { Fragment, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { SHAPE_TYPES, type ShapeType } from '@agent-board/daemon/protocol';
import { Input, Kbd, Segmented, Tooltip, type SegmentedOption } from '../../../ui';
import { SHAPE_GROUPS, SHAPES, type ShapeGroup } from './catalogue';
import { useRecentShapes } from './recents';
import { searchShapes } from './search';
import { ShapeIcon } from './ShapeArt';

type Tab = 'all' | ShapeGroup;
const TABS: SegmentedOption<Tab>[] = [{ id: 'all', label: 'All' }, ...SHAPE_GROUPS.map(({ id, name }) => ({ id, label: name }))];

/**
 * The shape picker (CL1): a search field, the recent shapes, then every shape by group, with tabs to show one group.
 * Typing filters the shapes by name and other words for them; Enter picks the first. `current` is pressed.
 */
export function ShapePicker({
  current,
  onPick,
  hint,
  onEscape,
  autoFocus = true,
}: {
  current?: ShapeType;
  onPick(shape: ShapeType): void;
  /** What the foot says a pick does. */
  hint: ReactNode;
  /**
   * Esc, wherever focus is in it: it closes the picker even while a shape's name shows, whose tooltip would otherwise
   * take the Esc for itself.
   */
  onEscape?(): void;
  /** Focuses the search as it opens: not when drawn in the component gallery. */
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const recents = useRecentShapes();
  const found = query.trim() === '' ? undefined : searchShapes(query).map(({ shape }) => shape);
  const grid = (label: string, shapes: readonly ShapeType[], count?: number) => (
    <section className="shape-picker-section" aria-label={label}>
      <h3 className="shape-picker-heading">
        {label}
        {count !== undefined && <small>{count}</small>}
      </h3>
      <div className="shape-picker-grid">
        {shapes.map((shape) => (
          <Tooltip key={shape} content={SHAPES[shape].name} side="top">
            <button
              type="button"
              className="shape-picker-cell"
              aria-label={SHAPES[shape].name}
              aria-pressed={current === undefined ? undefined : current === shape}
              data-shape={shape}
              onClick={() => onPick(shape)}
            >
              <ShapeIcon shape={shape} />
            </button>
          </Tooltip>
        ))}
      </div>
    </section>
  );
  return (
    <div
      className="shape-picker"
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onEscape?.();
      }}
    >
      <div className="shape-picker-search">
        <Input
          icon={<Search />}
          type="search"
          size="sm"
          aria-label="Search shapes"
          placeholder={`Search ${SHAPE_TYPES.length} shapes`}
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || found === undefined || found.length === 0) return;
            event.preventDefault();
            onPick(found[0]!);
          }}
        />
        <Kbd>S</Kbd>
      </div>
      <div className="shape-picker-scroll">
        {found === undefined ? (
          <>
            {recents.length > 0 && grid('Recent', recents)}
            <Segmented<Tab> aria-label="Shape groups" className="shape-picker-tabs" options={TABS} value={tab} onChange={setTab} />
            {SHAPE_GROUPS.filter(({ id }) => tab === 'all' || tab === id).map(({ id, name }) => {
              const shapes = SHAPE_TYPES.filter((shape) => SHAPES[shape].group === id);
              return <Fragment key={id}>{grid(name, shapes, shapes.length)}</Fragment>;
            })}
          </>
        ) : found.length === 0 ? (
          <p className="shape-picker-none">No shape matches “{query.trim()}”</p>
        ) : (
          grid('Matches', found, found.length)
        )}
      </div>
      <p className="shape-picker-foot">{hint}</p>
    </div>
  );
}
