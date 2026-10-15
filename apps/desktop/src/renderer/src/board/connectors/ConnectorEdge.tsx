import { memo, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import {
  CONNECTOR_LINE_ENDS,
  MAX_CONNECTOR_LABEL,
  TEXT_COLORS,
  type Connector,
  type ConnectorLineEnd,
} from '@agent-board/daemon/protocol';
import { Trash2 } from 'lucide-react';
import { BarButton, BarLabel, BarRow, BarSample, BarSeparator, BarSwatch } from '../items/ItemStyleBar';
import { Swatch } from '../../ui';
import { tokenNumber } from '../../theme';
import { themedColor } from '../../board-colors';
import { ConnectorActionsContext } from './actions';
import { shapeOf } from './endpoints';
import { useLine } from './line';
import { LineStyleButtons } from './LineStyleButtons';
import { upperFirst } from '../../upper-first';

export type ConnectorEdgeType = Edge<{ connector: Connector }, 'connector'>;

/** The marker that ends a line: `none` has none. Drawn once for the whole board, in `ConnectorMarkers`. */
const MARKERS: Record<ConnectorLineEnd, string | undefined> = {
  none: undefined,
  arrow: 'url(#connector-arrow)',
  dot: 'url(#connector-dot)',
};

/**
 * The arrow and dot a connector's ends can have, defined once for every line. They take the line's own colour
 * (`context-stroke`), so a coloured line has a matching end.
 */
export function ConnectorMarkers() {
  return (
    <svg className="connector-markers" aria-hidden="true">
      <defs>
        <marker
          id="connector-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M1.5 1.5 L8.5 5 L1.5 8.5" className="connector-arrow" />
        </marker>
        {/* A flow edge's: filled, in its colour (FlowDraw). */}
        <marker
          id="flow-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="11"
          markerHeight="11"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M1 1 L10 5 L1 9 Z" className="flow-arrow" />
        </marker>
        <marker
          id="connector-dot"
          viewBox="0 0 10 10"
          refX="5"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="userSpaceOnUse"
        >
          <circle cx="5" cy="5" r="2.75" className="connector-dot" />
        </marker>
      </defs>
    </svg>
  );
}

/** How a bar button draws each end (the start's samples mirror the end's). */
const END_SAMPLES: Record<'start' | 'end', Record<ConnectorLineEnd, string>> = {
  end: {
    none: 'M3 12 H21',
    arrow: 'M3 12 H21 M15 6 L21 12 L15 18',
    dot: 'M3 12 H17 M17 12 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0',
  },
  start: {
    none: 'M3 12 H21',
    arrow: 'M3 12 H21 M9 6 L3 12 L9 18',
    dot: 'M7 12 H21 M1 12 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0',
  },
};
/** About how wide a character of a connector's label is drawn, for keeping the line's handles off it. */
const LABEL_CHARACTER_WIDTH = 7;

/**
 * A connector: a thin neutral line between two board objects, with an optional label on its middle. Selected,
 * it can be bent and its ends moved to other sides of their objects.
 */
export const ConnectorEdge = memo(function ConnectorEdge(props: EdgeProps<ConnectorEdgeType>) {
  const { data, selected = false } = props;
  const connector = data!.connector;
  const { editing, edit, update, select } = useContext(ConnectorActionsContext);
  const { shape, handles } = useLine(
    props,
    connector.style,
    shapeOf(connector),
    (geometry) => update({ id: connector.id, ...geometry }),
    // Roughly, as drawn: the handles keep clear of it, so a press on it reaches it.
    connector.label === '' ? undefined : { width: connector.label.length * LABEL_CHARACTER_WIDTH + 2 * tokenNumber('--space-2'), height: tokenNumber('--control-row') },
  );
  const { path } = shape;
  const { x: labelX, y: labelY } = shape.label;
  const editingLabel = editing === connector.id;
  const style = connector.color === null ? undefined : ({ '--connector-color': themedColor(connector.color) } as CSSProperties);

  return (
    <>
      {selected && <path d={path} className="connector-halo" />}
      <BaseEdge
        id={props.id}
        path={path}
        className="connector-line"
        style={style}
        markerStart={MARKERS[connector.startEnd]}
        markerEnd={MARKERS[connector.endEnd]}
        interactionWidth={16}
      />
      <EdgeLabelRenderer>
        {(connector.label !== '' || editingLabel) && (
          <div
            className="connector-label nodrag nopan"
            data-testid="connector-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            onClick={() => select(connector.id)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              edit(connector.id);
            }}
          >
            {editingLabel ? (
              <LabelInput
                label={connector.label}
                onDone={(label) => {
                  edit(undefined);
                  if (label !== connector.label) update({ id: connector.id, label });
                }}
              />
            ) : (
              connector.label
            )}
          </div>
        )}
        {selected && !editingLabel && (
          <div
            className="connector-bar nodrag nopan"
            style={{
              transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <ConnectorBar connector={connector} />
          </div>
        )}
      </EdgeLabelRenderer>
      {selected && !editingLabel && handles}
    </>
  );
});

/** The label being typed: Enter or leaving it keeps what was typed, Escape drops it. */
function LabelInput({ label, onDone }: { label: string; onDone(label: string): void }) {
  const [draft, setDraft] = useState(label);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(keep ? draft.trim() : label);
  };
  return (
    // Not a `ui/` Field: it is typed in place on the line, sized to its text, with no box of its own.
    <input
      ref={input}
      className="connector-label-input"
      aria-label="Connector label"
      autoFocus
      value={draft}
      maxLength={MAX_CONNECTOR_LABEL}
      size={Math.max(draft.length, 4)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
      }}
    />
  );
}

/** The bar over a selected connector: its style, its two ends and its colour. */
function ConnectorBar({ connector }: { connector: Connector }) {
  const { update, remove } = useContext(ConnectorActionsContext);
  const set = (patch: Omit<Parameters<typeof update>[0], 'id'>) => update({ id: connector.id, ...patch });
  return (
    <div role="toolbar" aria-label="Connector" className="item-bar-rows">
      <BarRow>
        <LineStyleButtons current={connector.style} onPick={(style) => set({ style })} />
        <BarSeparator />
        {(['start', 'end'] as const).map((which) => (
          <EndButtons
            key={which}
            which={which}
            current={which === 'start' ? connector.startEnd : connector.endEnd}
            onPick={(end) => set(which === 'start' ? { startEnd: end } : { endEnd: end })}
          />
        ))}
        <BarSeparator />
        <BarButton name="Delete connector" onClick={() => remove(connector.id)}>
          <Trash2 />
        </BarButton>
      </BarRow>
      <BarRow>
        <BarLabel>Colour</BarLabel>
        <Swatch
          className="item-bar-swatch"
          color="var(--connector-line)"
          aria-label="Neutral"
          pressed={connector.color === null}
          onClick={() => set({ color: null })}
        />
        {TEXT_COLORS.slice(1).map((color) => (
          <BarSwatch
            key={color.value}
            name={color.name}
            value={color.value}
            pressed={connector.color === color.value}
            onPick={() => set({ color: color.value })}
          />
        ))}
      </BarRow>
    </div>
  );
}

function EndButtons({
  which,
  current,
  onPick,
}: {
  which: 'start' | 'end';
  current: ConnectorLineEnd;
  onPick(end: ConnectorLineEnd): void;
}) {
  return (
    <>
      <BarLabel>{upperFirst(which)}</BarLabel>
      {CONNECTOR_LINE_ENDS.map((end) => (
        <BarButton key={end} name={`${upperFirst(which)}: ${end}`} pressed={current === end} onClick={() => onPick(end)}>
          <BarSample path={END_SAMPLES[which][end]} />
        </BarButton>
      ))}
    </>
  );
}
