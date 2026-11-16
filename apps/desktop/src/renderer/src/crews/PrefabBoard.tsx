import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardPaste, Copy, Info, Link2, Maximize, Play, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import {
  applyEdgeChanges,
  applyNodeChanges,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  PanOnScrollMode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { EFFORTS, MAX_NAME_LENGTH, MAX_REVIEW_CAP, PROMPT_PLACE, isOrchestratorRole, ORCHESTRATOR_ROLE, type CrewPrefab, type Effort, type Harness, type PrefabMember, type PrefabPlaces } from '@agent-board/daemon/protocol';
import type { CharacterPose } from '@agent-board/daemon/character';
import { errorMessage } from '../../../shared/errors';
import { EFFORT_LABELS, MODELS } from '../board/AgentSetup';
import { BoardBackdrop } from '../board/BoardBackdrop';
import { useCharacterStyle } from '../board/characters';
import { TileCharacter } from '../board/TileCharacter';
import { useTileDesign } from '../board/tile-design';
import { stopPropagation } from '../board/tile-parts';
import { historyStep, inOverlay } from '../keys';
import { useEscStep } from '../keys/esc-ladder';
import { pressed } from '../keys/registry';
import { isTyping } from '../keys/typing';
import { Button, Dialog, IconButton, Input, Island, Kbd, Menu, Segmented, Select, Tag, Textarea, useToast, type MenuEntry } from '../ui';
import { CrewFaces, PrefabIcon, RoleIcon } from './icons';
import {
  addAgent,
  AGENT_KINDS,
  AGENT_TILE,
  boardDraft,
  boardPlaces,
  boardPrefab,
  boardSentence,
  firstAgent,
  lineMeaning,
  moved,
  pasted,
  PROMPT_PILL,
  startWord,
  withLine,
  withoutAgents,
  withoutLine,
  type AgentKind,
  type BoardAgent,
  type BoardDraft,
  type BoardLine,
} from './prefab-board';
import { MAX_PREFAB_NAME, memberLabel, modelChoice, readModelChoice } from './prefab-flow';
import { refreshPrefabs } from './prefab-store';
import { motionDuration, tokenNumber } from '../theme';

/** What opens a prefab on its board. */
export interface PrefabBoardStart {
  prefab: CrewPrefab & { places?: PrefabPlaces };
  /** The library's prefab a save writes over, by its name; null for one not saved yet (new, or a copy). */
  replaces: string | null;
  /** The agent selected as it opens. */
  select?: string;
  /** Said as it opens. */
  toast?: string;
}

interface PrefabBoardProps {
  start: PrefabBoardStart;
  /** The main board's desk, for the same dots behind it. */
  desk: { gap: number; size: number };
  /** Says whether it holds changes not saved yet, as that changes. */
  onEdited?(edited: boolean): void;
  onLeave(): void;
}

/** The icons a prefab may pick, in the order the row offers them. */
const ICONS = ['bug', 'ticket', 'crew', 'palette', 'review', 'rocket'] as const;
const ICON_NAMES: Record<string, string> = { bug: 'Bug', ticket: 'Ticket', crew: 'Crew', palette: 'Palette', review: 'Review', rocket: 'Rocket', agent: 'Agent', spike: 'Spike', lead: 'Lead' };
const MAX_PURPOSE = 200;
const HARNESS_NAMES: Record<Harness, string> = { claude: 'Claude', codex: 'Codex' };
const EFFORT_SHORT: Record<Effort, string> = { ...EFFORT_LABELS, xhigh: 'xhigh' };
const ON_BOARD = [
  { id: 'card', label: 'One card' },
  { id: 'tiles', label: 'Member tiles' },
  { id: 'ticket', label: 'Ticket' },
] as const;

/** The roles offered by name; any other is a role of the user's own, typed. */
const ROLES = [
  { id: 'implementer', label: 'Builder' },
  { id: 'reviewer', label: 'Reviewer' },
  { id: 'follow-up-reviewer', label: 'Follow-up reviewer' },
  { id: ORCHESTRATOR_ROLE, label: 'Lead' },
] as const;
const OWN_ROLE = '__own';
const listedRole = (role: string | null) => role === null || ROLES.some((each) => each.id === role.toLowerCase());

/** How each role stands on its tile, and what it does there. */
const POSES: Record<string, CharacterPose> = { implementer: 'writing', reviewer: 'reading', 'follow-up-reviewer': 'reading', [ORCHESTRATOR_ROLE]: 'thinking' };
const DOES: Record<string, string> = {
  implementer: 'Builds it, tests it, opens the PR',
  reviewer: 'Reads the branch, writes a review doc',
  'follow-up-reviewer': 'Reads what changed since the last review',
  [ORCHESTRATOR_ROLE]: 'Starts and runs the others',
};
const poseOf = (member: PrefabMember): CharacterPose => POSES[member.role ?? ''] ?? 'writing';
const doesOf = (member: PrefabMember) => DOES[member.role ?? ''] ?? (member.role === null ? 'Works on what it is given' : 'Draws the mocks, then hands off');

/** The kinds + Agent adds, with how each stands in the menu. */
const KINDS: { kind: AgentKind; label: string }[] = [
  { kind: 'builder', label: 'Builder' },
  { kind: 'reviewer', label: 'Reviewer' },
  { kind: 'designer', label: 'Designer' },
  { kind: 'lead', label: 'Lead' },
];

/** How far an arrow key moves the selection, as on the main board. */
const NUDGE = 1;
const NUDGE_FAR = 10;

type PromptNode = Node<Record<string, never>, 'prompt'>;
type AgentNode = Node<{ member: PrefabMember; word: { text: string; warn?: true }; line: boolean; own: boolean }, 'agent'>;
type BoardNode = PromptNode | AgentNode;
type LineEdge = Edge<{ label?: string; warn?: true }, 'line'>;

/** What was last copied on a prefab's board, for a paste on this one or the next. */
let copied: { agents: BoardAgent[]; lines: BoardLine[] } | undefined;

const lineId = (line: BoardLine) => `${line.from}>${line.to}`;

function nodesOf(draft: BoardDraft, selected: ReadonlySet<string>): BoardNode[] {
  const prompt: PromptNode = { id: PROMPT_PLACE, type: 'prompt', position: draft.prompt, data: {}, width: PROMPT_PILL.width, height: PROMPT_PILL.height, selected: selected.has(PROMPT_PLACE) };
  const lead = firstAgent(draft)?.member.id;
  return [
    prompt,
    ...draft.agents.map(
      (agent): AgentNode => ({
        id: agent.member.id,
        type: 'agent',
        position: agent.place,
        width: AGENT_TILE.width,
        height: AGENT_TILE.height,
        selected: selected.has(agent.member.id),
        data: {
          member: agent.member,
          word: startWord(draft, agent.member.id),
          line: draft.lines.some((line) => line.to === agent.member.id),
          own: agent.member.id === lead && agent.member.template !== null,
        },
      }),
    ),
  ];
}

function edgesOf(draft: BoardDraft, selected: ReadonlySet<string>): LineEdge[] {
  const { problems } = boardPrefab(draft);
  return draft.lines.map((line) => {
    const meaning = lineMeaning(draft, line);
    const to = draft.agents.find((agent) => agent.member.id === line.to)?.member;
    const warn = to !== undefined && problems.some((problem) => problem.includes(memberLabel(to)));
    return {
      id: lineId(line),
      type: 'line',
      source: line.from,
      target: line.to,
      selected: selected.has(lineId(line)),
      data: { ...(meaning === 'prompt' ? {} : { label: meaning === 'handoff' ? 'hand-off' : 'starts it' }), ...(warn ? { warn: true as const } : {}) },
    };
  });
}

/** The words for a line, as its panel and its toast say them. */
function lineWords(draft: BoardDraft, line: BoardLine): string {
  const name = (id: string) => {
    const member = draft.agents.find((agent) => agent.member.id === id)?.member;
    return member === undefined ? id : memberLabel(member);
  };
  const meaning = lineMeaning(draft, line);
  if (meaning === 'prompt') {
    const member = draft.agents.find((agent) => agent.member.id === line.to)?.member;
    return `Your prompt starts ${name(line.to)}. It is the crew’s ${member !== undefined && isOrchestratorRole(member.role) ? 'lead' : 'builder'}.`;
  }
  if (meaning === 'starts') return `${name(line.from)} starts ${name(line.to)} when it needs it.`;
  return `${name(line.to)} starts when ${name(line.from)} hands off, on a checkout of its branch.`;
}

/**
 * A crew prefab as a board of its own, zoomed into over the main one as a ticket's board is: Your prompt and an agent's
 * tile for each member, joined by the lines that say who starts whom. Selecting one changes it in the panel on the
 * right; nothing selected changes the prefab. Its keys are the main board's: undo, copy and paste, duplicate, nudge and
 * delete. A line the file can't hold is drawn all the same, and Save lists what to change. Esc or ◂ Board steps out,
 * asking first if there is anything unsaved.
 */
export function PrefabBoard(props: PrefabBoardProps) {
  return (
    <ReactFlowProvider>
      <PrefabBoardShown {...props} />
    </ReactFlowProvider>
  );
}

interface History {
  past: BoardDraft[];
  draft: BoardDraft;
  future: BoardDraft[];
  /** What the last step changed, for typing in one field to be one step. */
  field?: string;
}

function PrefabBoardShown({ start, desk, onEdited, onLeave }: PrefabBoardProps) {
  const toasts = useToast();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [history, setHistory] = useState<History>(() => ({ past: [], draft: boardDraft(start.prefab), future: [] }));
  const { draft } = history;
  const [replaces, setReplaces] = useState(start.replaces);
  // The draft as last saved: the board is edited while it is any other.
  const [saved, setSaved] = useState<BoardDraft | undefined>(() => (start.replaces === null ? undefined : history.draft));
  const dirty = draft !== saved;
  useEffect(() => onEdited?.(dirty), [dirty, onEdited]);
  const [asking, setAsking] = useState(false);

  /** Makes `next` the board, as one step to undo; typing in the same field again is the same step. */
  const commit = useCallback((next: BoardDraft | ((current: BoardDraft) => BoardDraft), field?: string) => {
    setHistory((current) => {
      const draft = typeof next === 'function' ? next(current.draft) : next;
      if (draft === current.draft) return current;
      if (field !== undefined && field === current.field) return { ...current, draft, future: [] };
      return { past: [...current.past, current.draft], draft, future: [], ...(field === undefined ? {} : { field }) };
    });
  }, []);
  const undo = useCallback(() => setHistory((current) => (current.past.length === 0 ? current : { past: current.past.slice(0, -1), draft: current.past.at(-1)!, future: [current.draft, ...current.future] })), []);
  const redo = useCallback(() => setHistory((current) => (current.future.length === 0 ? current : { past: [...current.past, current.draft], draft: current.future[0]!, future: current.future.slice(1) })), []);

  // React Flow's own copy of the board, for drags and selection; the draft is the truth, and each change of it redraws this.
  const [nodes, setNodes] = useState<BoardNode[]>(() => nodesOf(history.draft, new Set(start.select === undefined ? [] : [start.select])));
  const [edges, setEdges] = useState<LineEdge[]>(() => edgesOf(history.draft, new Set()));
  const picking = useRef<string[]>(undefined);
  useEffect(() => {
    const pick = picking.current;
    picking.current = undefined;
    setNodes((current) => nodesOf(draft, new Set(pick ?? current.filter((node) => node.selected === true).map((node) => node.id))));
    setEdges((current) => edgesOf(draft, new Set(pick === undefined ? current.filter((edge) => edge.selected === true).map((edge) => edge.id) : [])));
  }, [draft]);
  const select = useCallback((ids: string[]) => {
    const picked = new Set(ids);
    setNodes((current) => current.map((node) => (node.selected === picked.has(node.id) ? node : { ...node, selected: picked.has(node.id) })));
    setEdges((current) => current.map((edge) => (edge.selected === picked.has(edge.id) ? edge : { ...edge, selected: picked.has(edge.id) })));
  }, []);

  const selectedAgents = useMemo(() => nodes.filter((node): node is AgentNode => node.type === 'agent' && node.selected === true).map((node) => node.id), [nodes]);
  const selectedLine = useMemo(() => edges.find((edge) => edge.selected === true), [edges]);
  const selectedIds = new Set(selectedAgents);
  const agentsPicked = draft.agents.filter((agent) => selectedIds.has(agent.member.id));
  const linePicked = selectedLine === undefined ? undefined : draft.lines.find((line) => lineId(line) === selectedLine.id);

  const { prefab, problems } = useMemo(() => boardPrefab(draft), [draft]);

  const join = useCallback(
    ({ source, target }: Connection) => {
      const next = withLine(draft, source, target);
      if (next === draft) return;
      const before = firstAgent(draft)?.member.id;
      const replaced = draft.lines.some((line) => line.to === target);
      commit(next);
      const to = next.agents.find((agent) => agent.member.id === target)?.member;
      const name = to === undefined ? target : memberLabel(to);
      if (source === PROMPT_PLACE && before !== undefined && before !== target) toasts.show({ id: 'prefab-line', message: `Your prompt now goes to ${name}`, action: { label: 'Undo', onClick: undo, shortcut: '⌘Z' } });
      else if (replaced) toasts.show({ id: 'prefab-line', message: `Moved ${name}’s line. ${startWord(next, target).text}.`, action: { label: 'Undo', onClick: undo, shortcut: '⌘Z' } });
      else toasts.show({ id: 'prefab-line', message: `Joined. ${startWord(next, target).text}.` });
    },
    [draft, commit, toasts, undo],
  );

  const removeSelected = useCallback(() => {
    if (agentsPicked.length > 0) {
      commit(withoutAgents(draft, agentsPicked.map((agent) => agent.member.id)));
      const what = agentsPicked.length === 1 ? memberLabel(agentsPicked[0]!.member) : `${agentsPicked.length} agents`;
      toasts.show({ id: 'prefab-delete', message: `Deleted ${what}`, action: { label: 'Undo', onClick: undo, shortcut: '⌘Z' } });
    } else if (linePicked !== undefined) {
      commit(withoutLine(draft, linePicked));
      toasts.show({ id: 'prefab-delete', message: 'Deleted the line', action: { label: 'Undo', onClick: undo, shortcut: '⌘Z' } });
    }
  }, [agentsPicked, linePicked, draft, commit, toasts, undo]);

  const paste = useCallback(
    (from: { agents: readonly BoardAgent[]; lines: readonly BoardLine[] } | undefined) => {
      if (from === undefined || from.agents.length === 0) return;
      const copy = pasted(draft, from.agents, from.lines);
      picking.current = copy.ids;
      commit(copy.draft);
    },
    [draft, commit],
  );
  const picked = () => ({ agents: agentsPicked, lines: draft.lines.filter((line) => selectedIds.has(line.from) && selectedIds.has(line.to)) });
  const duplicate = () => paste(picked());

  /** A new agent of `kind` in the middle of the view, selected. */
  const add = (kind: AgentKind) => {
    const canvas = root.current?.querySelector('.prefab-board-canvas')?.getBoundingClientRect();
    const centre = canvas === undefined ? { x: 0, y: 0 } : screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 });
    const { draft: next, id } = addAgent(draft, kind, { x: Math.round(centre.x - AGENT_TILE.width / 2), y: Math.round(centre.y - AGENT_TILE.height / 2) });
    picking.current = [id];
    commit(next);
  };

  const save = useCallback(async (): Promise<boolean> => {
    if (problems.length > 0) {
      select([]);
      toasts.show({ id: 'prefab-save', tone: 'error', message: problems.length === 1 ? problems[0] : `${problems[0]} And ${problems.length - 1} more, in the panel.` });
      return false;
    }
    try {
      const done = await window.agentBoard.orchestrators.savePrefab(prefab, replaces ?? undefined, boardPlaces(draft));
      setReplaces(done.name);
      setSaved(draft);
      void refreshPrefabs();
      toasts.show({ id: 'prefab-save', tone: 'success', message: `Saved ${done.name}. It’s in + agent ▾ and Settings › Prefabs.` });
      return true;
    } catch (failure) {
      toasts.show({ id: 'prefab-save', tone: 'error', message: `Could not save it: ${errorMessage(failure)}` });
      return false;
    }
  }, [problems, prefab, replaces, draft, select, toasts]);

  const leave = useCallback(() => (dirty ? setAsking(true) : onLeave()), [dirty, onLeave]);

  // Esc lets go of what is selected first, then steps out.
  useEscStep(
    'level',
    (event) => {
      if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || asking) return false;
      const active = document.activeElement;
      return active === null || active === document.body || active.closest('.prefab-board') !== null;
    },
    () => {
      if (nodes.some((node) => node.selected === true) || edges.some((edge) => edge.selected === true)) select([]);
      else leave();
    },
  );

  // The board's keys, as the main board has them, which is off while this one is open. Never while typing, nor in a menu or dialog.
  const keys = useRef<(event: KeyboardEvent) => void>(undefined);
  keys.current = (event) => {
    const step = historyStep(event);
    if (asking || (isTyping(event) && step === undefined) || (isTyping(event) && (event.target as HTMLElement).tagName !== 'SELECT') || inOverlay()) return;
    const run = (action: () => unknown) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (step !== undefined) run(step === 'undo' ? undo : redo);
    else if (command && !event.shiftKey && !event.altKey && key === 's') run(() => void save());
    else if (pressed('edit.selectAll', event)) run(() => select(draft.agents.map((agent) => agent.member.id)));
    else if (pressed('edit.duplicate', event)) run(duplicate);
    else if (command && !event.shiftKey && !event.altKey && key === 'c' && agentsPicked.length > 0 && window.getSelection()?.isCollapsed !== false) run(() => (copied = picked()));
    else if (command && !event.shiftKey && !event.altKey && key === 'v' && copied !== undefined) run(() => paste(copied));
    else if ((event.key === 'Backspace' || event.key === 'Delete') && !command) run(removeSelected);
    else if (event.key.startsWith('Arrow') && !command && !event.altKey) {
      const by = event.shiftKey ? NUDGE_FAR : NUDGE;
      const [dx, dy] = event.key === 'ArrowLeft' ? [-by, 0] : event.key === 'ArrowRight' ? [by, 0] : event.key === 'ArrowUp' ? [0, -by] : [0, by];
      const shifted = new Map(nodes.filter((node) => node.selected === true).map((node) => [node.id, { x: node.position.x + dx, y: node.position.y + dy }]));
      if (shifted.size > 0) run(() => commit((current) => moved(current, shifted), 'nudge'));
    }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keys.current?.(event);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  // The keys are the board's once it opens.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
    if (start.toast !== undefined) toasts.show({ id: 'prefab-open', message: start.toast });
    // Once, as it opens.
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<BoardNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), current)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<LineEdge>[]) => setEdges((current) => applyEdgeChanges(changes.filter((change) => change.type !== 'remove'), current)), []);
  const change = (id: string, fields: Partial<PrefabMember>, field: string) =>
    commit((current) => ({ ...current, agents: current.agents.map((agent) => (agent.member.id === id ? { ...agent, member: { ...agent.member, ...fields } } : agent)) }), `${field}:${id}`);
  const changeAll = (ids: readonly string[], fields: (member: PrefabMember) => Partial<PrefabMember>) =>
    commit((current) => ({ ...current, agents: current.agents.map((agent) => (ids.includes(agent.member.id) ? { ...agent, member: { ...agent.member, ...fields(agent.member) } } : agent)) }));
  const changePrefab = (fields: Partial<BoardDraft>, field?: string) => commit((current) => ({ ...current, ...fields }), field);

  const addMenu: MenuEntry[] = [
    { heading: 'Add an agent' },
    ...KINDS.map(({ kind, label }) => ({ label, icon: <KindFace kind={kind} />, onSelect: () => add(kind) })),
    'separator',
    { label: 'Paste', icon: <ClipboardPaste aria-hidden />, shortcut: '⌘V', disabled: copied === undefined, onSelect: () => paste(copied) },
  ];

  return (
    <div
      ref={root}
      className="prefab-board"
      tabIndex={-1}
      data-testid="prefab-board"
      // The main board's own handlers (a note on a double-click, drops, its menu) are under this one: nothing here reaches them.
      onDoubleClick={stopPropagation}
      onDragOver={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <svg className="prefab-board-defs" aria-hidden>
        <defs>
          {['', '-on', '-warn'].map((tone) => (
            <marker key={tone} id={`prefab-arrow${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={`prefab-arrow${tone}`} />
            </marker>
          ))}
        </defs>
      </svg>
      <div className="prefab-board-canvas">
        <div className="island-top-centre ticket-board-bar prefab-board-bar">
          <Island className="ticket-board-crumb" data-testid="prefab-board-crumb" role="navigation" aria-label="Board level">
            <button type="button" className="ticket-board-crumb-back" data-testid="prefab-board-back" title="Back to the board (Esc)" onClick={leave}>
              <ChevronLeft aria-hidden />
              Board
            </button>
            <ChevronRight aria-hidden className="ticket-board-crumb-sep" />
            <span className="ticket-board-crumb-here" aria-current="page">
              <span className="ticket-board-crumb-icon">
                <PrefabIcon icon={draft.icon} />
              </span>
              <input
                className="prefab-board-name"
                aria-label="Prefab name"
                placeholder="Name it"
                value={draft.name}
                maxLength={MAX_PREFAB_NAME}
                size={Math.max(8, draft.name.length)}
                onChange={(event) => changePrefab({ name: event.target.value }, 'name')}
              />
              <span className="prefab-board-saved" data-testid="prefab-board-saved">
                {dirty ? '· edited' : replaces !== null ? '· saved' : ''}
              </span>
            </span>
          </Island>
          <Island className="prefab-board-actions" role="group" aria-label="Save">
            <IconButton icon={<Undo2 />} aria-label="Undo" title="Undo (⌘Z)" disabled={history.past.length === 0} onClick={undo} />
            <IconButton icon={<Redo2 />} aria-label="Redo" title="Redo (⇧⌘Z)" disabled={history.future.length === 0} onClick={redo} />
            <Button size="sm" variant="primary" data-testid="prefab-board-save" onClick={() => void save()}>
              Save
            </Button>
          </Island>
        </div>
        <ReactFlow<BoardNode, LineEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={join}
          onNodeDragStop={(_event, _node, dragged) => commit(moved(draft, new Map(dragged.map((node) => [node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }]))))}
          defaultEdgeOptions={{ type: 'line' }}
          connectionLineStyle={{ strokeDasharray: '6 4' }}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          zoomOnScroll={false}
          zoomOnPinch
          panOnDrag={[1]}
          selectionOnDrag
          panActivationKeyCode="Space"
          multiSelectionKeyCode="Shift"
          elevateNodesOnSelect={false}
          minZoom={0.1}
          fitView
          fitViewOptions={FIT}
          proOptions={{ hideAttribution: true }}
        >
          <BoardBackdrop gap={desk.gap} size={desk.size} />
        </ReactFlow>
        <Island className="prefab-board-dock" role="toolbar" aria-label="Add">
          <Menu entries={addMenu} side="top" align="center">
            <Button size="sm" variant="ghost" icon={<Plus />} data-testid="prefab-board-add">
              Agent
            </Button>
          </Menu>
          <Button size="sm" variant="ghost" icon={<Maximize />} onClick={() => void fitView({ ...FIT, duration: motionDuration(tokenNumber('--motion-base')) })}>
            Fit
          </Button>
        </Island>
        <p className="prefab-board-sentence" data-testid="prefab-board-sentence">
          <Info aria-hidden />
          <span>
            {boardSentence(draft).map((words, index) => (words.bold === true ? <b key={index}>{words.text}</b> : <span key={index}>{words.text}</span>))}
          </span>
        </p>
      </div>
      <aside className="prefab-board-side nodrag nowheel" aria-label="Change it" data-testid="prefab-board-side">
        {agentsPicked.length === 1 ? (
          <AgentPanel
            agent={agentsPicked[0]!}
            draft={draft}
            onChange={(fields, field) => change(agentsPicked[0]!.member.id, fields, field)}
            onDuplicate={duplicate}
            onDelete={removeSelected}
          />
        ) : agentsPicked.length > 1 ? (
          <AgentsPanel agents={agentsPicked} onChange={(fields) => changeAll(agentsPicked.map((agent) => agent.member.id), fields)} onDuplicate={duplicate} onDelete={removeSelected} />
        ) : linePicked !== undefined ? (
          <LinePanel draft={draft} line={linePicked} onDelete={removeSelected} />
        ) : (
          <PrefabPanel draft={draft} problems={problems} onChange={changePrefab} />
        )}
      </aside>
      {asking && (
        <Dialog
          role="alertdialog"
          title={`Save ${draft.name.trim() === '' ? 'this prefab' : draft.name}?`}
          onClose={() => setAsking(false)}
          footerStart={
            <Button
              variant="ghost"
              onClick={() => {
                setAsking(false);
                onLeave();
              }}
            >
              Discard
            </Button>
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setAsking(false)}>
                Stay
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setAsking(false);
                  void save().then((done) => done && onLeave());
                }}
              >
                Save
              </Button>
            </>
          }
        >
          It has changes you haven’t saved.
        </Dialog>
      )}
    </div>
  );
}

/** A kind's robot, in + Agent's menu. */
function KindFace({ kind }: { kind: AgentKind }) {
  const style = useCharacterStyle();
  const member = { id: kind, name: null, role: AGENT_KINDS[kind].role };
  if (style === 'off') return <RoleIcon member={member} />;
  return (
    <span className="prefab-kind-face" aria-hidden>
      <TileCharacter harness="claude" pose={POSES[AGENT_KINDS[kind].role] ?? 'writing'} style={style} height={18} />
    </span>
  );
}

function PromptPill({ selected }: NodeProps<PromptNode>) {
  return (
    <div className="prefab-prompt" data-selected={selected || undefined} data-testid="prefab-prompt">
      <Play aria-hidden />
      Your prompt
      <Handle type="source" position={Position.Right} className="prefab-handle" />
    </div>
  );
}

/** An agent of the prefab, drawn in the board's tile design, with the start it has. */
function AgentTile({ data: { member, word, own }, selected }: NodeProps<AgentNode>) {
  const design = useTileDesign();
  const style = useCharacterStyle();
  const label = memberLabel(member);
  const pose = poseOf(member);
  const now = member.template !== null && member.template.trim() !== '' ? `“${member.template.trim().split('\n')[0]}”` : doesOf(member);
  const Glyph = word.warn === true ? AlertTriangle : word.text === 'Starts on your prompt' ? Play : Link2;
  const tags = (
    <>
      <Tag mono>{[member.harness, member.model, member.effort].filter((part) => part !== null).join(' · ')}</Tag>
      {member.role !== null && <Tag>{member.role === ORCHESTRATOR_ROLE ? 'lead' : member.role}</Tag>}
      {own && <Tag tone="accent">own prompt</Tag>}
    </>
  );
  const handles = (
    <>
      <Handle type="target" position={Position.Left} className="prefab-handle" />
      <Handle type="source" position={Position.Right} className="prefab-handle" />
    </>
  );
  const common = { 'data-testid': 'prefab-agent', 'data-selected': selected || undefined, 'data-warn': word.warn, 'data-harness': member.harness, 'data-member': member.id };
  if (design === 'shelf') {
    return (
      <div className="hybrid-tile hybrid-tile-agent glance-tile shelf-tile prefab-agent" {...common}>
        {style !== 'off' && (
          <span className="shelf-tile-peek" data-style={style} data-pose={pose}>
            <TileCharacter harness={member.harness} pose={pose} style={style} height={36} />
          </span>
        )}
        <div className="shelf-tile-body">
          <div className="shelf-tile-head">
            <span className="hybrid-tile-name">{label}</span>
          </div>
          <span className="shelf-tile-line">{now}</span>
          <div className="shelf-tile-meta">{tags}</div>
        </div>
        <div className="shelf-tile-band" data-level={word.warn === true ? '2' : '1'}>
          <Glyph aria-hidden className="shelf-tile-glyph" />
          <span className="shelf-tile-word">{word.text}</span>
        </div>
        {handles}
      </div>
    );
  }
  return (
    <div className="hybrid-tile hybrid-tile-agent glance-tile porthole-tile prefab-agent" {...common}>
      <div className="porthole-head">
        <span className="porthole-port" data-ring={word.warn === true ? 'ask' : undefined} data-look={style === 'off' ? 'icons' : style}>
          {style === 'off' ? <RoleIcon member={member} /> : <TileCharacter harness={member.harness} pose={pose} style={style} height={25} />}
        </span>
        <span className="porthole-about">
          <span className="porthole-name">
            <span className="hybrid-tile-name">{label}</span>
          </span>
          <span className="porthole-word" data-tone={word.warn === true ? 'chip' : 'work'}>
            <Glyph aria-hidden className="porthole-word-glyph" />
            {word.text}
          </span>
        </span>
      </div>
      <span className="porthole-now">{now}</span>
      <span className="porthole-meta">{tags}</span>
      {handles}
    </div>
  );
}

function Line({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<LineEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const tone = selected === true ? '-on' : data?.warn === true ? '-warn' : '';
  return (
    <>
      <BaseEdge id={id} path={path} className="prefab-line" data-selected={selected || undefined} data-warn={data?.warn} markerEnd={`url(#prefab-arrow${tone})`} interactionWidth={16} />
      {data?.label !== undefined && (
        <EdgeLabelRenderer>
          <span className="prefab-line-label" data-selected={selected || undefined} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { prompt: PromptPill, agent: AgentTile };
const EDGE_TYPES = { line: Line };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prefab-side-field">
      <span className="prefab-side-label">{label}</span>
      {children}
    </div>
  );
}

function PrefabPanel({ draft, problems, onChange }: { draft: BoardDraft; problems: readonly string[]; onChange(fields: Partial<BoardDraft>, field?: string): void }) {
  const icons = ICONS.includes(draft.icon as never) ? ICONS : [draft.icon, ...ICONS];
  return (
    <>
      <h2 className="prefab-side-title">Prefab</h2>
      <Field label="Icon">
        <span className="prefab-icon-row" role="radiogroup" aria-label="Icon">
          {icons.map((icon) => (
            <button key={icon} type="button" role="radio" aria-checked={icon === draft.icon} aria-label={ICON_NAMES[icon] ?? icon} title={ICON_NAMES[icon] ?? icon} onClick={() => onChange({ icon })}>
              <PrefabIcon icon={icon} />
            </button>
          ))}
        </span>
      </Field>
      <Field label="What it’s for">
        <Textarea aria-label="What it’s for" rows={2} maxLength={MAX_PURPOSE} value={draft.purpose} onChange={(event) => onChange({ purpose: event.target.value }, 'purpose')} />
      </Field>
      <Field label="Stop after">
        <Select aria-label="Stop after" value={String(draft.roundLimit)} onChange={(event) => onChange({ roundLimit: Number(event.target.value) })}>
          {Array.from({ length: MAX_REVIEW_CAP }, (_, index) => index + 1).map((rounds) => (
            <option key={rounds} value={rounds}>
              {rounds} {rounds === 1 ? 'round' : 'rounds'}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="On the board">
        <Segmented aria-label="On the board" value={draft.onBoard} onChange={(onBoard) => onChange({ onBoard })} options={ON_BOARD} />
      </Field>
      <Field label="Before it can be saved">
        {problems.length === 0 ? (
          <span className="prefab-ready" data-testid="prefab-ready">
            Ready to save
          </span>
        ) : (
          <ul className="prefab-problems" data-testid="prefab-problems">
            {problems.map((problem) => (
              <li key={problem}>
                <AlertTriangle aria-hidden />
                {problem}
              </li>
            ))}
          </ul>
        )}
      </Field>
      <p className="prefab-side-note">Select an agent or a line to change it. Box-select several to set them all at once.</p>
    </>
  );
}

function ModelSelect({ value, harness, model, onChange, mixed = false }: { value: string; harness: Harness; model: string | null; mixed?: boolean; onChange(harness: Harness, model: string | null): void }) {
  return (
    <span className="prefab-ai">
      <span className="prefab-harness-mark" data-harness={mixed ? undefined : harness} aria-hidden />
      <Select
        aria-label="AI and model"
        value={value}
        onChange={(event) => {
          const picked = readModelChoice(event.target.value);
          onChange(picked.harness, picked.model);
        }}
      >
        {mixed && (
          <option value="" disabled>
            Mixed
          </option>
        )}
        {(['claude', 'codex'] as const).map((each) => (
          <optgroup key={each} label={HARNESS_NAMES[each]}>
            <option value={modelChoice(each, null)}>{HARNESS_NAMES[each]} · its default</option>
            {[...MODELS[each], ...(each === harness && model !== null && !MODELS[each].includes(model) ? [model] : [])].map((name) => (
              <option key={name} value={modelChoice(each, name)}>
                {HARNESS_NAMES[each]} · {name}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </span>
  );
}

function EffortRow({ value, harness, onChange }: { value: Effort | null; harness: Harness | null; onChange(effort: Effort): void }) {
  const efforts = EFFORTS.filter((effort) => harness !== 'codex' || effort !== 'max');
  return <Segmented<Effort> className="prefab-efforts" aria-label="Reasoning" value={value ?? ('' as Effort)} onChange={onChange} options={efforts.map((effort) => ({ id: effort, label: EFFORT_SHORT[effort] }))} />;
}

/** A Codex agent has no `max`: it reasons at `xhigh` there. */
const effortFor = (harness: Harness, effort: Effort | null): Effort | null => (harness === 'codex' && effort === 'max' ? 'xhigh' : effort);

function AgentPanel({ agent, draft, onChange, onDuplicate, onDelete }: { agent: BoardAgent; draft: BoardDraft; onChange(fields: Partial<PrefabMember>, field: string): void; onDuplicate(): void; onDelete(): void }) {
  const { member } = agent;
  const style = useCharacterStyle();
  const own = !listedRole(member.role);
  const lead = firstAgent(draft)?.member.id === member.id;
  const word = startWord(draft, member.id);
  const hasLine = draft.lines.some((line) => line.to === member.id);
  return (
    <>
      <h2 className="prefab-side-title">Agent</h2>
      <div className="prefab-side-who">
        <span className="porthole-port" data-look={style === 'off' ? 'icons' : style} aria-hidden>
          {style === 'off' ? <RoleIcon member={member} /> : <TileCharacter harness={member.harness} pose={poseOf(member)} style={style} height={25} />}
        </span>
        <Input aria-label="Agent name" placeholder={memberLabel({ ...member, name: null })} value={member.name ?? ''} maxLength={MAX_NAME_LENGTH} onChange={(event) => onChange({ name: event.target.value === '' ? null : event.target.value }, 'name')} />
      </div>
      <Field label="Role">
        <Select
          aria-label="Role"
          value={own ? OWN_ROLE : (member.role?.toLowerCase() ?? '')}
          onChange={(event) => {
            const role = event.target.value;
            onChange(role === OWN_ROLE ? { role: 'designer' } : { role: role === '' ? null : role, template: null }, 'role');
          }}
        >
          {ROLES.map((role) => (
            <option key={role.id} value={role.id}>
              {role.label}
            </option>
          ))}
          <option value="">No role</option>
          <option value={OWN_ROLE}>A role of your own…</option>
        </Select>
        {own && <Input aria-label="Role name" placeholder="designer" value={member.role ?? ''} maxLength={24} onChange={(event) => onChange({ role: event.target.value.toLowerCase() }, 'role-name')} />}
      </Field>
      <Field label="AI and model">
        <ModelSelect value={modelChoice(member.harness, member.model)} harness={member.harness} model={member.model} onChange={(harness, model) => onChange({ harness, model, effort: effortFor(harness, member.effort) }, 'model')} />
      </Field>
      <Field label="Reasoning">
        <EffortRow value={member.effort} harness={member.harness} onChange={(effort) => onChange({ effort }, 'effort')} />
      </Field>
      <Field label="Prompt">
        {own && member.role !== null && member.role !== '' && (lead || member.template !== null) ? (
          <Textarea aria-label="Its prompt" rows={4} placeholder="Leave empty to use the role’s own" value={member.template ?? ''} onChange={(event) => onChange({ template: event.target.value === '' ? null : event.target.value }, 'template')} />
        ) : (
          <p className="prefab-side-note">
            {lead ? 'A built-in role’s prompt is each zone’s own. Pick a role of your own to give this agent a prompt here.' : 'Only the agent your prompt starts has a prompt of its own. This one uses its role’s.'}
          </p>
        )}
      </Field>
      <div className="prefab-startbox" data-warn={word.warn}>
        <b>{word.text}</b>
        <span>{hasLine ? 'To change it, move its line.' : 'Drag from a dot to join it.'}</span>
      </div>
      <div className="prefab-side-actions">
        <Button size="sm" variant="secondary" icon={<Copy />} onClick={onDuplicate}>
          Duplicate <Kbd>⌘D</Kbd>
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete <Kbd>⌫</Kbd>
        </Button>
      </div>
    </>
  );
}

function AgentsPanel({ agents, onChange, onDuplicate, onDelete }: { agents: readonly BoardAgent[]; onChange(fields: (member: PrefabMember) => Partial<PrefabMember>): void; onDuplicate(): void; onDelete(): void }) {
  const members = agents.map((agent) => agent.member);
  const choices = new Set(members.map((member) => modelChoice(member.harness, member.model)));
  const efforts = new Set(members.map((member) => member.effort));
  const harnesses = new Set(members.map((member) => member.harness));
  const first = members[0]!;
  return (
    <>
      <h2 className="prefab-side-title">{members.length} agents</h2>
      <div className="prefab-side-many">
        <CrewFaces members={members} />
        <span>{members.map(memberLabel).join(', ')}</span>
      </div>
      <Field label="AI and model, for all">
        <ModelSelect
          value={choices.size === 1 ? modelChoice(first.harness, first.model) : ''}
          mixed={choices.size > 1}
          harness={first.harness}
          model={first.model}
          onChange={(harness, model) => onChange((member) => ({ harness, model, effort: effortFor(harness, member.effort) }))}
        />
      </Field>
      <Field label="Reasoning">
        <EffortRow value={efforts.size === 1 ? first.effort : null} harness={harnesses.size === 1 ? first.harness : null} onChange={(effort) => onChange((member) => ({ effort: effortFor(member.harness, effort) }))} />
      </Field>
      <div className="prefab-side-actions">
        <Button size="sm" variant="secondary" icon={<Copy />} onClick={onDuplicate}>
          Duplicate <Kbd>⌘D</Kbd>
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete {members.length}
        </Button>
      </div>
    </>
  );
}

function LinePanel({ draft, line, onDelete }: { draft: BoardDraft; line: BoardLine; onDelete(): void }) {
  const to = draft.agents.find((agent) => agent.member.id === line.to)?.member;
  return (
    <>
      <h2 className="prefab-side-title">Line</h2>
      <div className="prefab-startbox">
        <span>{lineWords(draft, line)}</span>
      </div>
      <p className="prefab-side-note">Delete it and {to === undefined ? 'its agent' : memberLabel(to)} has no way to start, so Save will ask for a new line.</p>
      <div className="prefab-side-actions">
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete line <Kbd>⌫</Kbd>
        </Button>
      </div>
    </>
  );
}

/** The icons a prefab picks from, for other places that offer the same row. */
export const PREFAB_ICONS = ICONS;

/** How the board fits its agents in view: never past their own size, as a ticket's board does. */
const FIT = { maxZoom: 1 } as const;
