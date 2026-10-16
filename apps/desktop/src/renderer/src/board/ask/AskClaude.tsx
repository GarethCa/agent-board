import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type Ref } from 'react';
import { useReactFlow, useStoreApi, ViewportPortal, type InternalNode, type ReactFlowState } from '@xyflow/react';
import { Sparkles } from 'lucide-react';
import type { Agent, BoardItem, Connector, Zone } from '@agent-board/daemon/protocol';
import { NEW_AGENT_SIZE } from '@agent-board/daemon/board-layout';
import { errorMessage } from '../../../../shared/errors';
import { commandKey, inOverlay } from '../../keys';
import { AnchoredPopover, Button, Checkbox, ErrorText, Kbd, Segmented, Textarea } from '../../ui';
import type { Rect } from '../../geometry';
import { AgentSetupChips, type AgentSetup } from '../AgentSetup';
import { CONNECTOR_EDGE_PREFIX, endOfNode, nodeIdOf } from '../connectors/endpoints';
import { selectedNodes } from '../editing/selection';
import { boundsOnBoard, isItemNode, placeOnBoard } from '../items/items';
import { isSessionTile, isZone, repoName, type BoardNode } from '../tiles';
import { isTyping } from '../use-tile-moves';
import { answerSpots, captureZoom, selectionAsk, selectionSummary, type DiagramObject, type SelectionAsk } from './selection-diagram';

/** What the popover asks to begin with. */
const DEFAULT_QUESTION = 'Review this architecture: risks, gaps, alternatives.';
/** Marks the page while the selection is drawn for its picture, so the board's overlays and the popover are left out. */
const CAPTURING = 'capturing-selection';
/** Marks what is drawn in the picture while everything else is hidden. */
const CAPTURED = 'captured';
/** The room kept round the selection in the window while it is drawn, CSS px. */
const CAPTURE_MARGIN = 16;

const SETUP: AgentSetup = { harness: 'claude', model: '', role: 'architect' };

/** Where the answer goes: a note beside the selection, with or without suggested edits drawn on the diagram. */
type AnswerGoes = 'note' | 'edits';

/** The selection being asked about, and the zone it is in, if any. */
interface Asking extends SelectionAsk {
  zone: Zone | undefined;
}

/** What a selected item says, as its node's text in the diagram. */
function itemText(item: BoardItem): string | undefined {
  const { data } = item;
  const text = typeof data.text === 'string' ? data.text : undefined;
  if (item.kind === 'link') return typeof data.title === 'string' && data.title !== '' ? data.title : (data.url as string | undefined);
  if (item.kind === 'issue') return [data.id, data.title].filter((part) => typeof part === 'string' && part !== '').join(' ');
  return text;
}

/** The selected objects as the diagram has them: items, tiles, and what is in a selected zone. */
function selectedObjects(state: ReactFlowState, zones: readonly Zone[]): DiagramObject[] {
  const nodes = [...state.nodeLookup.values()];
  const { all } = selectedNodes(nodes);
  const picked = new Set(all.map((node) => node.id));
  // A selected zone's tiles and items come with it; the zone itself is their group.
  const inside = nodes.filter((node) => node.parentId !== undefined && picked.has(node.parentId) && !picked.has(node.id));
  return [...all, ...inside].flatMap((node): DiagramObject[] => {
    const user = node.internals.userNode as BoardNode;
    if (isZone(user)) return [];
    const end = endOfNode(user, 'right');
    if (end === undefined) return [];
    const rect = boundsOnBoard(user, { ...node.internals.positionAbsolute, width: node.measured.width ?? 0, height: node.measured.height ?? 0 });
    const zone = node.parentId === undefined ? undefined : zones.find((each) => each.id === node.parentId)?.name;
    const placed = zone === undefined ? {} : { zone };
    if (isItemNode(user)) {
      const { item } = user.data;
      const shape = item.kind === 'shape' && typeof item.data.shape === 'string' ? { shape: item.data.shape } : {};
      return [{ end, kind: item.kind, ...shape, text: itemText(item), rect, ...placed }];
    }
    if (isSessionTile(user)) {
      const subject = user.data.agent ?? user.data.shell ?? user.data.external;
      const name = subject !== undefined && 'name' in subject && typeof subject.name === 'string' ? subject.name : undefined;
      return [{ end, kind: end.type, text: name, rect, ...placed }];
    }
    return [];
  });
}

/** The zone most of the selection is in, if any: the one whose repo the agent may read. */
function zoneOf(state: ReactFlowState, zones: readonly Zone[]): Zone | undefined {
  const counts = new Map<string, number>();
  for (const node of selectedNodes(state.nodeLookup.values()).all as InternalNode[]) {
    const id = isZone(node.internals.userNode as BoardNode) ? node.id : node.parentId;
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best === undefined ? undefined : zones.find((zone) => zone.id === best[0]);
}

interface AskClaudeOptions {
  loaded: boolean;
  zones(): readonly Zone[];
  connectors(): readonly Connector[];
  zoneLayouts(): (Rect & { id: string })[];
  onStarted(agent: Agent): void;
}

/**
 * Ask Claude about the selection: `open` (the selection's label, its right-click menu, or ⌘⇧A) opens the popover beside
 * it, and Ask sends the selection's picture and diagram to a new agent, whose first answer the daemon puts beside it.
 * Nothing is sent until Ask.
 */
export function useAskClaude({ loaded, zones, connectors, zoneLayouts, onStarted }: AskClaudeOptions) {
  const store = useStoreApi();
  const [asking, setAsking] = useState<Asking>();

  const open = useCallback(() => {
    const state = store.getState();
    const known = zones();
    const ask = selectionAsk(selectedObjects(state, known), connectors());
    if (ask !== undefined) setAsking({ ...ask, zone: zoneOf(state, known) });
  }, [store, zones, connectors]);

  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!commandKey(event) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'a' || isTyping(event) || inOverlay()) return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loaded, open]);

  const popover = asking !== undefined && (
    <AskClaudePopover
      asking={asking}
      zoneLayouts={zoneLayouts}
      onClose={() => setAsking(undefined)}
      onStarted={(agent) => {
        setAsking(undefined);
        onStarted(agent);
      }}
    />
  );
  return { open, popover };
}

/** A point on the board for a popover to point at: it moves with the board. */
function AnchorPoint({ x, y, ref, ...rest }: { x: number; y: number; ref?: Ref<HTMLDivElement> }) {
  return (
    <ViewportPortal>
      <div ref={ref} className="ask-claude-anchor" style={{ '--anchor-x': `${x}px`, '--anchor-y': `${y}px` } as CSSProperties} aria-hidden {...rest} />
    </ViewportPortal>
  );
}

/** Two frames: what a class or a view change draws has been painted. */
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** The popover (CM): what to ask, the agent's harness, model and role, whether it may read the repo, and where the answer goes. */
function AskClaudePopover({
  asking,
  zoneLayouts,
  onClose,
  onStarted,
}: {
  asking: Asking;
  zoneLayouts(): (Rect & { id: string })[];
  onClose(): void;
  onStarted(agent: Agent): void;
}) {
  const { getViewport, setViewport } = useReactFlow();
  const store = useStoreApi();
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [setup, setSetup] = useState<AgentSetup>(SETUP);
  const repo = asking.zone?.repoRoot ?? asking.zone?.defaultRepo ?? null;
  const [readRepo, setReadRepo] = useState(repo !== null);
  const [goes, setGoes] = useState<AnswerGoes>('edits');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const { bounds } = asking;

  /**
   * Draws the selected objects alone, and the connectors between them, on a clean page: everything else is hidden
   * meanwhile, the board's chrome too. At 2 picture pixels to a board px, unless it would not fit in the window at
   * that; the view is put back after. Resolves with where the PNG is and its scale.
   */
  const capture = async (): Promise<{ path: string; scale: number }> => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    if (pane === undefined) throw new Error('the board is not showing');
    const before = getViewport();
    const { zoom, scale } = captureZoom(bounds, { width: pane.width - 2 * CAPTURE_MARGIN, height: pane.height - 2 * CAPTURE_MARGIN }, window.devicePixelRatio, store.getState().maxZoom);
    const shown = [
      ...Object.values(asking.objects).map((end) => `.react-flow__node[data-id="${CSS.escape(nodeIdOf(end))}"]`),
      ...asking.connectorIds.flatMap((id) => [`[data-testid="rf__edge-${CSS.escape(`${CONNECTOR_EDGE_PREFIX}${id}`)}"]`, `.connector-label[data-connector="${CSS.escape(id)}"]`]),
    ];
    const marked = [...document.querySelectorAll(shown.join(','))];
    document.documentElement.classList.add(CAPTURING);
    for (const element of marked) element.classList.add(CAPTURED);
    try {
      await setViewport({ x: CAPTURE_MARGIN - bounds.x * zoom, y: CAPTURE_MARGIN - bounds.y * zoom, zoom });
      await painted();
      const rect = { x: pane.left + CAPTURE_MARGIN, y: pane.top + CAPTURE_MARGIN, width: bounds.width * zoom, height: bounds.height * zoom };
      return { path: await window.agentBoard.agents.captureSelection(rect, Math.round(bounds.width * scale)), scale };
    } finally {
      for (const element of marked) element.classList.remove(CAPTURED);
      document.documentElement.classList.remove(CAPTURING);
      await setViewport(before);
    }
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (sending || question.trim() === '') return;
    setSending(true);
    setError(undefined);
    try {
      const picture = await capture();
      const spots = answerSpots(bounds);
      const layouts = zoneLayouts();
      const agent = await window.agentBoard.agents.askSelection({
        question: question.trim(),
        harness: setup.harness,
        model: setup.model || undefined,
        role: setup.role ?? undefined,
        zoneId: asking.zone?.id ?? null,
        readRepo: readRepo && repo !== null,
        suggest: goes === 'edits',
        diagram: asking.diagram,
        objects: asking.objects,
        origin: asking.origin,
        picturePath: picture.path,
        pictureScale: picture.scale,
        anchor: asking.anchor,
        note: placeOnBoard(spots.note, { width: 272, height: 120 }, layouts),
        tile: placeOnBoard(spots.tile, { width: 320, height: 200 }, layouts),
        ...NEW_AGENT_SIZE,
      });
      onStarted(agent);
    } catch (failure) {
      setError(errorMessage(failure));
      setSending(false);
    }
  };

  const summary = selectionSummary(asking.diagram);
  return (
    <AnchoredPopover
      // Pointed at from the right of the selection's top, where the note will go.
      anchor={<AnchorPoint x={bounds.x + bounds.width} y={bounds.y} />}
      open onOpenChange={(open) => !open && !sending && onClose()} aria-label="Ask Claude" className="ask-claude">
      <form className="ask-claude-form" onSubmit={(event) => void send(event)}>
        <div className="ask-claude-head">
          <Sparkles className="ask-claude-spark" aria-hidden />
          Ask Claude
          <small>{summary}</small>
        </div>
        <Textarea
          aria-label="What to ask"
          value={question}
          rows={3}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) void send(event);
          }}
        />
        <AgentSetupChips setup={setup} onChange={setSetup} />
        {repo !== null && (
          <Checkbox
            checked={readRepo}
            onChange={(event) => setReadRepo(event.target.checked)}
            label={
              <>
                Let it read <b className="mono">{repoName(repo)}</b> (read only, no worktree)
              </>
            }
          />
        )}
        <div className="ask-claude-goes">
          <span className="ask-claude-label">The answer goes</span>
          <Segmented<AnswerGoes>
            aria-label="The answer goes"
            value={goes}
            onChange={setGoes}
            options={[
              { id: 'note', label: 'Note beside it' },
              { id: 'edits', label: 'Note + suggested edits' },
            ]}
          />
        </div>
        <div className="ask-claude-sends">
          <span>Sends</span>
          <span className="ask-claude-file">selection.png · 2×</span>
          <span className="ask-claude-file">selection.json</span>
        </div>
        {error !== undefined && <ErrorText>{error}</ErrorText>}
        <div className="ask-claude-actions">
          <span className="ask-claude-where">{asking.zone === undefined ? 'Starts an agent on the board' : `Starts an agent in ${asking.zone.name}`}</span>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={sending || question.trim() === ''}>
            {sending ? 'Asking…' : 'Ask'} <Kbd>↵</Kbd>
          </Button>
        </div>
      </form>
    </AnchoredPopover>
  );
}
