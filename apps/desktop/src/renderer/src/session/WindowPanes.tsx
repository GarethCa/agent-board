import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import type { Placement, WindowPane } from '@agent-board/daemon/window-layout';
import { dropZoneAt, type DropZone, type Rect } from './pane-geometry';
import { dropTaken, tabDrag, useTabDrag } from './shell-moves';
import { TabStrip, type StripTab } from './TabStrip';
import type { WindowSurface } from './tabs';
import { OpenWebDialog } from './WebTab';
import { Dividers, useDividerDrag } from './use-divider-drag';
import type { PaneView, WindowPanesControl } from './use-window-panes';

const percent = (fraction: number) => `${fraction * 100}%`;

const paneId = (pane: WindowPane) => pane.id;

/** A pane's box, as fractions of the window. */
const boxStyle = ({ x, y, width, height }: Rect): CSSProperties => ({ left: percent(x), top: percent(y), width: percent(width), height: percent(height) });

/** A surface's box: its pane's, under the pane's strip (which CSS sizes). */
const surfaceStyle = ({ x, y, width, height }: Rect) => ({ left: percent(x), width: percent(width), '--pane-top': percent(y), '--pane-height': percent(height) }) as CSSProperties;

interface WindowPanesProps {
  panes: WindowPanesControl;
  /** How a surface's tab shows in its strip. */
  stripTab(surface: WindowSurface): StripTab;
  /** What a surface shows; `visible` while its pane shows it. */
  renderSurface(surface: WindowSurface, visible: boolean): ReactNode;
  /** Where a new shell starts, as the + menu says: "in this worktree", "in this folder". */
  here: string;
  /** The id of the panel that shows a surface, for its tab's `aria-controls`. */
  panelId(key: string): string;
  /** The one pane's strip is drawn by the window, in its own strip: only panes of a split have strips of their own. */
  inlineStrip: boolean;
}

/**
 * A session window's panes: each with its strip of tabs over the surface it shows. Every
 * surface is laid out flat and keyed by itself, so moving a tab to another pane, or splitting one, never re-mounts a
 * terminal; those not showing stay attached behind the one that is. A tab dragged over a pane shows where it would
 * land: in its strip from the middle, or in a new pane at an edge.
 */
export function WindowPanes({ panes, stripTab, renderSurface, here, panelId, inlineStrip }: WindowPanesProps) {
  const container = useRef<HTMLDivElement>(null);
  const { dividers } = useDividerDrag(container, panes.layout, paneId, panes.resize);
  const dragging = useTabDrag();
  // A frame after the drag starts: covering what is dragged (a pane's header) as it starts would end the drag at once.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (dragging === undefined) return;
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, [dragging]);
  const accepting = armed && dragging !== undefined && panes.accepts(dragging);
  const several = panes.panes.length > 1;
  return (
    <div className="window-panes" ref={container} data-testid="window-panes" data-panes={panes.panes.length} data-inline-strip={inlineStrip || undefined}>
      {!inlineStrip &&
        panes.panes.map((pane) => (
          <div
            key={pane.id}
            className="window-pane"
            data-testid="window-pane"
            data-pane={pane.id}
            data-focused={(several && pane.id === panes.focusedPane.id) || undefined}
            style={boxStyle(pane.rect)}
            onMouseDownCapture={() => panes.focusPane(pane.id)}
          >
            <PaneStrip panes={panes} pane={pane} stripTab={stripTab} here={here} panelId={panelId} focused={several && pane.id === panes.focusedPane.id} />
          </div>
        ))}
      {panes.surfaces.map((surface) => {
        const pane = panes.panes.find((each) => each.surfaces.includes(surface));
        if (pane === undefined) return null;
        const visible = pane.active.key === surface.key;
        return (
          <div
            key={surface.key}
            id={panelId(surface.key)}
            role="tabpanel"
            aria-label={surface.label}
            className="window-surface session-tab-view"
            data-testid="session-tab-view"
            data-tab={surface.kind === 'tab' ? surface.tab.id : surface.key}
            data-pane={pane.id}
            data-focused={(visible && pane.id === panes.focusedPane.id) || undefined}
            hidden={!visible}
            style={surfaceStyle(pane.rect)}
            onMouseDownCapture={() => panes.focusPane(pane.id)}
          >
            {renderSurface(surface, visible)}
          </div>
        );
      })}
      {accepting && panes.panes.map((pane) => <PaneDrop key={pane.id} panes={panes} pane={pane} />)}
      <Dividers {...dividers} className="shell-divider window-divider" testId="window-divider" />
    </div>
  );
}

/** One pane's strip: its tabs, + and Split acting on it. */
export function PaneStrip({
  panes,
  pane,
  stripTab,
  here,
  panelId,
  focused,
}: {
  panes: WindowPanesControl;
  pane: PaneView;
  stripTab(surface: WindowSurface): StripTab;
  here: string;
  panelId(key: string): string;
  focused: boolean;
}) {
  const [askingWeb, setAskingWeb] = useState(false);
  return (
    <>
    <TabStrip
      tabs={pane.surfaces.map(stripTab)}
      active={pane.active.key}
      focused={focused}
      here={here}
      panelId={panelId}
      onSelect={panes.select}
      onClose={panes.close}
      onNewShell={() => panes.newTab(pane.id)}
      onNewShellAt={() => panes.newTabAt(pane.id)}
      onRunScript={(script) => panes.newTab(pane.id, { script })}
      scripts={panes.scripts}
      sessions={panes.sessionChoices.map((choice) => ({ label: choice.label, onSelect: () => panes.showSession(pane.id, choice.surface) }))}
      pullRequests={panes.pullRequestChoices.map((choice) => ({ label: choice.label, onSelect: () => panes.open(choice.surface, pane.id) }))}
      onOpenWeb={() => setAskingWeb(true)}
      named={panes.surfaces.length === 1}
      shells={panes.holdsShells}
      onSplit={() => panes.split('horizontal', pane.id)}
      dragOf={(key) => {
        const surface = pane.surfaces.find((each) => each.key === key);
        return surface === undefined ? undefined : panes.dragOf(surface);
      }}
      drop={{ accepts: panes.accepts, onDrop: (drag, index) => panes.drop(drag, { pane: pane.id, index }) }}
    />
    {askingWeb && <OpenWebDialog suggested={panes.webSuggestion} onOpen={(url) => panes.openWeb(url, pane.id)} onClose={() => setAskingWeb(false)} />}
    </>
  );
}

/**
 * Over a pane's body while a tab that would land in the window is dragged: shows where it would go, its strip or a new
 * pane at the edge nearest the pointer, and lands it there.
 */
function PaneDrop({ panes, pane }: { panes: WindowPanesControl; pane: PaneView }) {
  const [zone, setZone] = useState<DropZone>();
  const dragging = useTabDrag();
  useEffect(() => {
    if (dragging === undefined) setZone(undefined);
  }, [dragging]);
  const zoneOf = (event: DragEvent<HTMLElement>): DropZone => {
    const box = event.currentTarget.getBoundingClientRect();
    return dropZoneAt({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
  };
  const placement = (at: DropZone): Placement => (at === 'center' ? { pane: pane.id } : { pane: pane.id, edge: at });
  return (
    <div
      className="window-pane-drop"
      data-testid="window-pane-drop"
      data-pane={pane.id}
      data-zone={zone}
      style={surfaceStyle(pane.rect)}
      onDragOver={(event) => {
        if (tabDrag() === undefined) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setZone(zoneOf(event));
      }}
      onDragLeave={() => setZone(undefined)}
      onDrop={(event) => {
        const drag = tabDrag();
        if (drag === undefined || !panes.accepts(drag)) return;
        // The pane's, not the board's under it.
        event.preventDefault();
        event.stopPropagation();
        setZone(undefined);
        dropTaken();
        panes.drop(drag, placement(zoneOf(event)));
      }}
    />
  );
}
