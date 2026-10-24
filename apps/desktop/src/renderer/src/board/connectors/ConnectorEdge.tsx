import { memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react';
import {
  CONNECTOR_LINE_ENDS,
  MAX_CONNECTOR_LABEL,
  SLOT_COLORS,
  colorSlotOf,
  type Connector,
  type ConnectorLineEnd,
} from '@agent-board/daemon/protocol';
import { ChevronDown, Trash2 } from 'lucide-react';
import { BarButton, BarLabel, BarRow, BarSample, BarSeparator, BarSwatch, slotTitle } from '../items/ItemStyleBar';
import { Button, Menu, Swatch } from '../../ui';
import { tokenNumber } from '../../theme';
import { connectorPaint, covers, foldLines, slotName, slotToken } from '../../board-colors';
import { useFoldedSlots } from '../items/use-folded-slots';
import { binding, isActive, keyText } from '../../keys/registry';
import { useExtendedShortcuts } from '../../keys/extended-shortcuts';
import { ConnectorActionsContext, type ConnectorLabelPlace } from './actions';
import { endOfNode, shapeOf } from './endpoints';
import { END_TRIM, labelNear, lineDashes } from './ends';
import { endLabelAt, samplePath } from './geometry';
import { useLine } from './line';
import { LineStyleButtons, RouteButton } from './LineStyleButtons';
import { RELATIONS, relationOf, swapped, type Relation } from './relations';
import { upperFirst } from '../../upper-first';

export type ConnectorEdgeType = Edge<{ connector: Connector }, 'connector'>;

/** The marker that ends a line: `none` has none. Drawn once for the whole board, in `ConnectorMarkers`. */
const MARKERS: Record<ConnectorLineEnd, string | undefined> = {
  none: undefined,
  arrow: 'url(#connector-arrow)',
  dot: 'url(#connector-dot)',
  triangle: 'url(#connector-triangle)',
  diamond: 'url(#connector-diamond)',
  'filled-diamond': 'url(#connector-filled-diamond)',
};

/**
 * The ends a connector can have, defined once for every line: an arrow, a dot, and a class diagram's hollow triangle
 * and hollow and filled diamonds, each with its tip on the line's end. They take the line's own colour
 * (`context-stroke`), so a coloured line has a matching end; a dashed line's are solid. The line stops at the back of a
 * hollow one (`END_TRIM`), so it doesn't show through it.
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
        {/* A flow edge's: filled, in its colour. */}
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
        {/* A one-way rail's: small and open, at its receiving end. */}
        <marker
          id="rail-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M1.5 1.5 L8.5 5 L1.5 8.5" className="rail-arrow" />
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
        <marker
          id="connector-triangle"
          viewBox="0 0 12 12"
          refX="11"
          refY="6"
          markerWidth="12"
          markerHeight="12"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M1 1 L11 6 L1 11 Z" className="connector-hollow" />
        </marker>
        {(['diamond', 'filled-diamond'] as const).map((end) => (
          <marker
            key={end}
            id={`connector-${end}`}
            viewBox="0 0 18 10"
            refX="17"
            refY="5"
            markerWidth="18"
            markerHeight="10"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M1 5 L9 1 L17 5 L9 9 Z" className={end === 'diamond' ? 'connector-hollow' : 'connector-filled'} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

/** How a sample draws each end: its line, and a part of it drawn filled. */
type EndSample = { path: string; filled?: string };

/** How a bar button draws each end at the end of a line; a start's is the same, mirrored. */
const END_SAMPLES: Record<ConnectorLineEnd, EndSample> = {
  none: { path: 'M3 12 H21' },
  arrow: { path: 'M3 12 H21 M15 6 L21 12 L15 18' },
  dot: { path: 'M3 12 H17 M17 12 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0' },
  triangle: { path: 'M3 12 H13 M13 6 L21 12 L13 18 Z' },
  diamond: { path: 'M3 12 H9 M9 12 L15 8 L21 12 L15 16 Z' },
  'filled-diamond': { path: 'M3 12 H9', filled: 'M9 12 L15 8 L21 12 L15 16 Z' },
};

/** What each end is called on its button. */
const END_NAMES: Record<ConnectorLineEnd, string> = {
  none: 'none',
  arrow: 'arrow',
  dot: 'dot',
  triangle: 'hollow triangle',
  diamond: 'hollow diamond',
  'filled-diamond': 'filled diamond',
};

/** About how wide a character of a connector's label is drawn (its middle one's italic, or an end's smaller mono), for keeping clear of it. */
const LABEL_CHARACTER_WIDTH = 7;

/** Each of a connector's labels at an end: the end it is by, the field it is kept in, and its name while typed. */
const END_LABELS = [
  { which: 'from', place: 'startLabel', name: 'Start label' },
  { which: 'to', place: 'endLabel', name: 'End label' },
] as const;

/**
 * A connector: a thin neutral line between two board objects, solid or dashed, with an optional label on its
 * middle and one by each end. Selected, it can be bent (a curve bowed) and its ends moved to other sides of their
 * objects, or onto other objects. A double-click near an end types that end's label; elsewhere, the middle one.
 */
export const ConnectorEdge = memo(function ConnectorEdge(props: EdgeProps<ConnectorEdgeType>) {
  const { data, selected = false } = props;
  const connector = data!.connector;
  const { editing, edit, update, select } = useContext(ConnectorActionsContext);
  const { getNode, screenToFlowPosition } = useReactFlow();
  const endOn = (nodeId: string) => {
    const node = getNode(nodeId);
    return node === undefined ? undefined : endOfNode(node, 'top');
  };
  const { shape, handles, routed } = useLine(
    props,
    connector.style,
    shapeOf(connector),
    (geometry) => update({ id: connector.id, ...geometry }),
    // Roughly, as drawn: the handles keep clear of it, so a press on it reaches it.
    connector.label === '' ? undefined : { width: connector.label.length * LABEL_CHARACTER_WIDTH + 2 * tokenNumber('--space-2'), height: tokenNumber('--control-row') },
    {
      // Either end goes onto any other object a connector can join.
      canEndOn: (nodeId) => endOn(nodeId) !== undefined,
      onDoubleClick: () => edit(connector.id),
      onMoved: (which, nodeId, { fromSide, toSide, points }) => {
        const end = endOn(nodeId);
        // A connector's sides are always picked: its moved end's is the one nearest where it was let go.
        const side = which === 'from' ? fromSide : toSide;
        if (end !== undefined && side !== 'auto') update({ id: connector.id, points, [which]: { ...end, side } });
      },
    },
  );
  const { path, length } = shape;
  const { x: labelX, y: labelY } = shape.label;
  const editingPlace = editing?.id === connector.id ? editing.place : undefined;
  const samples = useMemo(() => samplePath(path), [path]);
  const dashes = useMemo(
    () => lineDashes(length, END_TRIM[connector.startEnd], END_TRIM[connector.endEnd], connector.dashed),
    [length, connector.startEnd, connector.endEnd, connector.dashed],
  );
  const style = { ...(connector.color === null ? {} : { '--connector-color': connectorPaint(connector.color) }), strokeDasharray: dashes } as CSSProperties;
  const finish = (place: ConnectorLabelPlace) => (text: string) => {
    edit(undefined);
    if (text !== connector[place]) update({ id: connector.id, [place]: text });
  };

  return (
    <>
      {selected && <path d={path} className="connector-halo" />}
      <g
        onDoubleClick={(event) => {
          // The board's own double-click on an edge would type the middle label: this one picks which.
          event.stopPropagation();
          edit(connector.id, labelNear(screenToFlowPosition({ x: event.clientX, y: event.clientY }), samples));
        }}
      >
        <BaseEdge
          id={props.id}
          path={path}
          className="connector-line"
          style={style}
          // Its dashes are measured along it as `shape` measures it, so a line stops just where its hollow end begins.
          pathLength={length}
          markerStart={MARKERS[connector.startEnd]}
          markerEnd={MARKERS[connector.endEnd]}
          interactionWidth={16}
          data-routed={routed || undefined}
          data-dashed={connector.dashed || undefined}
        />
      </g>
      <EdgeLabelRenderer>
        {(connector.label !== '' || editingPlace === 'label') && (
          <div
            className="connector-label nodrag nopan"
            data-testid="connector-label"
            data-connector={connector.id}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            onClick={() => select(connector.id)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              edit(connector.id);
            }}
          >
            {editingPlace === 'label' ? <LabelInput label={connector.label} name="Connector label" onDone={finish('label')} /> : connector.label}
          </div>
        )}
        {END_LABELS.map(({ which, place, name }) => {
          const text = connector[place];
          if (text === '' && editingPlace !== place) return null;
          const size = { width: Math.max(text.length, 4) * LABEL_CHARACTER_WIDTH + 2 * tokenNumber('--space-1'), height: tokenNumber('--connector-end-label-height') };
          const at = endLabelAt(samples, which, size);
          return (
            <div
              key={place}
              className="connector-end-label nodrag nopan"
              data-testid="connector-end-label"
              data-end={which}
              data-connector={connector.id}
              style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
              onClick={() => select(connector.id)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                edit(connector.id, place);
              }}
            >
              {editingPlace === place ? <LabelInput label={text} name={name} onDone={finish(place)} /> : text}
            </div>
          );
        })}
        {selected && editingPlace === undefined && (
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
      {selected && editingPlace === undefined && handles}
    </>
  );
});

/** A label being typed, named `name`: Enter or leaving it keeps what was typed, Escape drops it. */
function LabelInput({ label, name, onDone }: { label: string; name: string; onDone(label: string): void }) {
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
      aria-label={name}
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

/** A relation's sample: its line, dashed or solid, with its ends. */
function RelationSample({ look }: { look: Relation['look'] }) {
  const end = END_SAMPLES[look.endEnd];
  const start = END_SAMPLES[look.startEnd];
  // One end at a time has a shape: the sample draws the line with it, at the side it is on.
  const shaped = look.startEnd === 'none' ? end : start;
  return <BarSample path={shaped.path} filled={shaped.filled} dashed={look.dashed} mirrored={look.startEnd !== 'none'} />;
}

/**
 * The bar over a selected connector: its style; the relation it draws, in a class diagram's words, which sets its ends
 * and dash at once; its two ends and dash one by one, once asked for or when they are no relation; and its colour.
 */
function ConnectorBar({ connector }: { connector: Connector }) {
  const { update, remove } = useContext(ConnectorActionsContext);
  const set = (patch: Omit<Parameters<typeof update>[0], 'id'>) => update({ id: connector.id, ...patch });
  const relation = RELATIONS.find(({ id }) => id === relationOf(connector));
  const [customEnds, setCustomEnds] = useState(false);
  const lineColors = useFoldedSlots(foldLines);
  // A new key, so off with the Extended keyboard shortcuts setting: ⇧S then arms the Shape tool, and the row says none.
  const extended = useExtendedShortcuts();
  return (
    <div role="toolbar" aria-label="Connector" className="item-bar-rows">
      <BarRow>
        <LineStyleButtons current={connector.style} onPick={(style) => set({ style })} />
        <RouteButton style={connector.style} bent={connector.points.length > 0} onRoute={() => set({ points: [] })} />
        <BarSeparator />
        <Menu
          entries={[
            ...RELATIONS.map(({ label, reads, look }) => ({
              label,
              hint: reads,
              icon: <RelationSample look={look} />,
              onSelect: () => set(look),
            })),
            'separator' as const,
            { label: 'Custom ends…', onSelect: () => setCustomEnds(true) },
            { label: 'Swap direction', shortcut: isActive(binding('edit.swapDirection'), extended) ? keyText('edit.swapDirection') : undefined, onSelect: () => set(swapped(connector)) },
          ]}
        >
          <Button variant="ghost" size="sm" className="item-bar-button" aria-label="Relation" trailingIcon={<ChevronDown />}>
            {relation?.label ?? 'Custom'}
          </Button>
        </Menu>
        <BarSeparator />
        <BarButton name="Delete connector" onClick={() => remove(connector.id)}>
          <Trash2 />
        </BarButton>
      </BarRow>
      {(customEnds || relation === undefined) && (
        <BarRow>
          <EndButtons which="start" current={connector.startEnd} onPick={(startEnd) => set({ startEnd })} />
          <BarSeparator />
          <BarButton name="Dashed" pressed={connector.dashed} onClick={() => set({ dashed: !connector.dashed })}>
            <BarSample path={END_SAMPLES.none.path} dashed />
          </BarButton>
          <BarSeparator />
          <EndButtons which="end" current={connector.endEnd} onPick={(endEnd) => set({ endEnd })} />
        </BarRow>
      )}
      <BarRow>
        <BarLabel>Colour</BarLabel>
        <Swatch
          className="item-bar-swatch"
          color="var(--connector-line)"
          aria-label="Neutral"
          pressed={connector.color === null}
          onClick={() => set({ color: null })}
        />
        {/* Its colour is stored as its slot's, which is drawn as the slot: the neutral line stands for Ink. */}
        {lineColors.map((group) => (
          <BarSwatch
            key={group.slot}
            name={slotName(group.slot)}
            title={slotTitle(group.slot, group.also)}
            paint={slotToken(group.slot)}
            folded={group.also.length > 0}
            pressed={covers(group, connector.color === null ? null : colorSlotOf(connector.color))}
            onPick={() => set({ color: SLOT_COLORS[group.slot] })}
          />
        ))}
        {connector.color !== null && colorSlotOf(connector.color) === null && (
          <BarSwatch name={`${connector.color}, fixed`} title={`${connector.color} · fixed`} paint={connector.color} fixed pressed onPick={() => undefined} />
        )}
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
        <BarButton key={end} name={`${upperFirst(which)}: ${END_NAMES[end]}`} pressed={current === end} onClick={() => onPick(end)}>
          <BarSample path={END_SAMPLES[end].path} filled={END_SAMPLES[end].filled} mirrored={which === 'start'} />
        </BarButton>
      ))}
    </>
  );
}
