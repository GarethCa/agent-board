import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Copy,
  FastForward,
  Flag,
  GitBranch,
  GitMerge,
  Hourglass,
  Inbox,
  Info,
  Maximize,
  Play,
  Plus,
  Redo2,
  Repeat,
  Ticket,
  Trash2,
  Undo2,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
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
  useStore,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import {
  defaultFresh,
  defaultWorks,
  effortOn,
  isMakerRole,
  MAX_GATE_ROUNDS,
  MAX_NAME_LENGTH,
  MAX_PREFAB_TIMEOUT,
  MAX_REVIEW_CAP,
  MIN_PREFAB_TIMEOUT,
  ORCHESTRATOR_ROLE,
  DEFAULT_GATE_TIMEOUT,
  type CrewPrefab,
  type Effort,
  type Harness,
  type PrefabAssumption,
  type PrefabGate,
  type PrefabInput,
  type PrefabInputKind,
  type PrefabLine,
  type PrefabMember,
  type PrefabPlaces,
  type LibraryPrefab,
} from '@agent-board/daemon/protocol';
import { lineKey } from '@agent-board/daemon/prefab-graph-checks';
import type { CharacterPose } from '@agent-board/daemon/character';
import { errorMessage } from '../../../shared/errors';
import { EFFORT_LABELS, MODELS } from '../board/AgentSetup';
import { BoardBackdrop } from '../board/BoardBackdrop';
import { GlanceLine } from '../board/GlanceLine';
import { useCharacterStyle } from '../board/characters';
import { TileCharacter } from '../board/TileCharacter';
import { useTileDesign } from '../board/tile-design';
import { stopPropagation } from '../board/tile-parts';
import { historyStep, inOverlay } from '../keys';
import { useEscStep } from '../keys/esc-ladder';
import { pressed } from '../keys/registry';
import { isTyping } from '../keys/typing';
import { Button, Checkbox, Dialog, IconButton, Input, Island, IslandSeparator, Kbd, Menu, Segmented, Select, Tag, Textarea, useToast, type MenuEntry } from '../ui';
import { CrewFaces, PrefabIcon, RoleIcon } from './icons';
import { PrefabDraftNote } from './PrefabDraftNote';
import { draftSummary } from './draft-review';
import {
  addAgent,
  addGate,
  addInput,
  AGENT_KINDS,
  AGENT_TILE,
  boardDraft,
  boardPlaces,
  boardPrefab,
  boardSentence,
  branchTag,
  againDepth,
  againDip,
  fitPadding,
  joinCount,
  fitViewport,
  graphBounds,
  CLOCK_SCHEDULES,
  GATE_SIZE,
  lineKind,
  lineWords,
  nodeName,
  moved,
  pasted,
  pillSize,
  startWord,
  withGate,
  withInput,
  withInputKind,
  SOURCE_KINDS,
  isSourceKind,
  type SourceKind,
  withLine,
  withLineSet,
  withoutLine,
  withoutNodes,
  type AgentKind,
  type BoardAgent,
  type BoardDraft,
  type BoardProblem,
  type LineKind,
  sharedEfforts,
} from './prefab-board';
import { gateRule, gateWait, joinBadge, MAX_PREFAB_NAME, memberLabel, modelChoice, readModelChoice } from './prefab-flow';
import { refreshPrefabs } from './prefab-store';
import { motionDuration, tokenNumber } from '../theme';

/** What opens a prefab on its board. */
export interface PrefabBoardStart {
  prefab: CrewPrefab & { places?: PrefabPlaces };
  /** The library's prefab a save writes over, by its name; null for one not saved yet (new, or a copy). */
  replaces: string | null;
  /** What is selected as it opens: a node by its id, or a line by its key. */
  select?: string;
  /** Said as it opens. */
  toast?: string;
  /** A draft an agent made, by its id: not in the library until saved, and kept or deleted as the board is left. */
  draft?: OpenedDraft;
}

/** A prefab draft as its board shows it: its id, who drafted it, and what they assumed. */
export interface OpenedDraft {
  id: string;
  drafter: string;
  /** The drafter's session, for the zone a crew started from it is suggested. */
  drafterSession?: string;
  assumptions: PrefabAssumption[];
}

interface PrefabBoardProps {
  start: PrefabBoardStart;
  /** The main board's desk, for the same dots behind it. */
  desk: { gap: number; size: number };
  /** Says whether it holds changes not saved yet, as that changes. */
  onEdited?(edited: boolean): void;
  onLeave(): void;
  /** Starts a crew from it, once saved to the library: its prompt box opens, as the library's Start opens it. */
  onStart?(prefab: LibraryPrefab, draft: OpenedDraft): void;
  /** False for a board that must not take the page's focus as it opens: the gallery's, beside other controls. */
  takesFocus?: boolean;
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

/** Each input's pill: its words and its icon. */
const INPUT_FACES: Record<PrefabInputKind, { label: string; Icon: LucideIcon }> = {
  prompt: { label: 'Your prompt', Icon: Play },
  user: { label: 'Your OK', Icon: UserCheck },
  queue: { label: 'The queue', Icon: Inbox },
  ticket: { label: 'The ticket', Icon: Ticket },
  clock: { label: 'The clock', Icon: Clock },
  end: { label: 'Ready to merge', Icon: GitMerge },
};
const inputFace = (input: PrefabInput) => (input.kind === 'end' && input.as === 'done' ? { label: 'Done', Icon: Flag } : INPUT_FACES[input.kind]);

/** What the dock adds after + Agent, in its order. */
const DOCK_INPUTS: { kind: PrefabInputKind; label: string }[] = [
  { kind: 'user', label: 'Your OK' },
  { kind: 'queue', label: 'Queue' },
  { kind: 'ticket', label: 'Ticket' },
  { kind: 'clock', label: 'Clock' },
  { kind: 'end', label: 'End' },
];

type InputNode = Node<{ input: PrefabInput; warn: boolean }, 'pill'>;
type AgentNode = Node<{ member: PrefabMember; word: { text: string; warn?: true }; own: boolean; badge: string | null; branch: string | null; warn: boolean }, 'agent'>;
type GateNode = Node<{ gate: PrefabGate; rule: string; wait: string | null; warn: boolean }, 'gate'>;
type BoardNode = InputNode | AgentNode | GateNode;
type LineEdge = Edge<{ kind: LineKind; label?: string; depth?: number; warn?: true }, 'line'>;

/** What was last copied on a prefab's board, for a paste on this one or the next. */
let copied: { agents: BoardAgent[]; lines: PrefabLine[] } | undefined;

const fromPrompt = (draft: BoardDraft, id: string) => draft.lines.some((line) => line.to === id && draft.inputs.some((each) => each.input.id === line.from && each.input.kind === 'prompt'));
/** The lines that bring a member work, other than a loop gate's again line. */
const linesIn = (draft: BoardDraft, id: string) => draft.lines.filter((line) => line.to === id && line.way !== 'again');
/** The members whose lines go into a loop gate: those who decide whether it goes round again. */
const decidersOf = (draft: BoardDraft, id: string) => draft.agents.filter((agent) => draft.lines.some((line) => line.from === agent.member.id && line.to === id)).map((agent) => agent.member);

/**
 * The board's nodes, each with its size: they are rebuilt from the draft at each change, which drops what React Flow
 * measured, and React Flow never shows a node it has no size for.
 */
function nodesOf(draft: BoardDraft, problems: readonly BoardProblem[], selected: ReadonlySet<string>): BoardNode[] {
  const wrong = new Set(problems.map((problem) => problem.about));
  return [
    ...draft.inputs.map(
      ({ input, place }): InputNode => ({ id: input.id, type: 'pill', position: place, ...pillSize(input.kind), selected: selected.has(input.id), data: { input, warn: wrong.has(input.id) } }),
    ),
    ...draft.agents.map(
      ({ member, place }): AgentNode => ({
        id: member.id,
        type: 'agent',
        position: place,
        width: AGENT_TILE.width,
        height: AGENT_TILE.height,
        selected: selected.has(member.id),
        data: {
          member,
          word: startWord(draft, member.id),
          own: fromPrompt(draft, member.id) && member.template !== null,
          badge: joinBadge(member, joinCount(draft, member.id)),
          branch: branchTag(draft, member.id),
          warn: wrong.has(member.id),
        },
      }),
    ),
    ...draft.gates.map(
      ({ gate, place }): GateNode => ({
        id: gate.id,
        type: 'gate',
        position: place,
        width: GATE_SIZE.width,
        height: GATE_SIZE.height,
        selected: selected.has(gate.id),
        data: { gate, rule: gateRule(gate, decidersOf(draft, gate.id)), wait: gateWait(gate, decidersOf(draft, gate.id).length), warn: wrong.has(gate.id) },
      }),
    ),
  ];
}

const LINE_LABELS: Partial<Record<LineKind, string>> = { again: 'again', done: 'done', lead: 'starts' };

function edgesOf(draft: BoardDraft, problems: readonly BoardProblem[], selected: ReadonlySet<string>): LineEdge[] {
  const wrong = new Set(problems.map((problem) => problem.about));
  return draft.lines.map((line) => {
    const kind = lineKind(line);
    // A plain line between agents is a hand-off and says nothing; only again, done and starts lines carry a word.
    const label = LINE_LABELS[kind];
    return {
      id: lineKey(line),
      type: 'line',
      source: line.from,
      target: line.to,
      sourceHandle: kind === 'again' ? 'again' : 'out',
      targetHandle: kind === 'again' ? 'back' : 'in',
      selected: selected.has(lineKey(line)),
      data: { kind, ...(label === undefined ? {} : { label }), ...(kind === 'again' ? { depth: againDip(draft, line) } : {}), ...(wrong.has(lineKey(line)) ? { warn: true as const } : {}) },
    };
  });
}

/** A member with `fields` changed, a field set to undefined taken off. */
type MemberFields = { [K in keyof PrefabMember]?: PrefabMember[K] | undefined };
function changedMember(member: PrefabMember, fields: MemberFields): PrefabMember {
  const next = { ...member, ...fields } as PrefabMember & Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) if (value === undefined) delete next[key];
  return next;
}

/**
 * A crew prefab as a board of its own, zoomed into over the main one as a ticket's board is: its graph, with a pill for
 * each input (Your prompt, Your OK, a queue, a ticket, a clock, an end), an agent's tile for each member, a loop gate
 * for each loop, and the lines between them that say where work goes. Selecting one changes it in the panel on the
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

function PrefabBoardShown({ start, desk, onEdited, onLeave, onStart, takesFocus = true }: PrefabBoardProps) {
  const toasts = useToast();
  const { screenToFlowPosition, setViewport } = useReactFlow();
  const flow = useStoreApi();
  const [history, setHistory] = useState<History>(() => ({ past: [], draft: boardDraft(start.prefab), future: [] }));
  const { draft } = history;
  const foot = useRef<HTMLDivElement>(null);
  const draftNote = useRef<HTMLElement>(null);
  const fit = useCallback(
    (duration?: number) => {
      const bounds = graphBounds(draft);
      const { width, height } = flow.getState();
      if (bounds === null || width === 0 || height === 0) return;
      const room = fitRoom(foot.current?.offsetHeight ?? 0);
      // A draft's note sits over the canvas's left: the graph fits beside it.
      const note = draftNote.current === null ? 0 : draftNote.current.offsetLeft + draftNote.current.offsetWidth;
      void setViewport(fitViewport(bounds, { width, height }, { ...room, left: Math.max(room.left, note + room.right) }, FIT_ZOOM), { duration });
    },
    [draft, flow, setViewport],
  );
  // Fit once, when the canvas first has a size.
  const paneWidth = useStore((state) => state.width);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || paneWidth === 0) return;
    fitted.current = true;
    fit();
  }, [paneWidth, fit]);
  const [replaces, setReplaces] = useState(start.replaces);
  // The draft as last saved: the board is edited while it is any other.
  const [saved, setSaved] = useState<BoardDraft | undefined>(() => (start.replaces === null ? undefined : history.draft));
  const dirty = draft !== saved;
  useEffect(() => onEdited?.(dirty), [dirty, onEdited]);
  const [asking, setAsking] = useState(false);
  // The draft this board opened, until it is saved.
  const [agentDraft, setAgentDraft] = useState(start.draft);
  /** Deletes the draft an agent made, now it is saved or discarded: saying so if it stays in Settings › Prefabs › Drafts. */
  const dropDraft = useCallback(
    (id: string, done: string) =>
      void window.agentBoard.orchestrators
        .removeDraft(id)
        .catch((failure: unknown) => toasts.show({ id: 'prefab-draft', tone: 'error', message: `${done} its draft is still in Settings › Prefabs › Drafts: ${errorMessage(failure)}` })),
    [toasts],
  );

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
  const { prefab, problems } = useMemo(() => boardPrefab(draft), [draft]);
  const [nodes, setNodes] = useState<BoardNode[]>(() => nodesOf(history.draft, problems, new Set(start.select === undefined ? [] : [start.select])));
  const [edges, setEdges] = useState<LineEdge[]>(() => edgesOf(history.draft, problems, new Set(start.select === undefined ? [] : [start.select])));
  const picking = useRef<string[]>(undefined);
  useEffect(() => {
    const pick = picking.current;
    picking.current = undefined;
    setNodes((current) => nodesOf(draft, problems, new Set(pick ?? current.filter((node) => node.selected === true).map((node) => node.id))));
    setEdges((current) => edgesOf(draft, problems, new Set(pick === undefined ? current.filter((edge) => edge.selected === true).map((edge) => edge.id) : [])));
  }, [draft, problems]);
  const select = useCallback((ids: string[]) => {
    const picked = new Set(ids);
    setNodes((current) => current.map((node) => (node.selected === picked.has(node.id) ? node : { ...node, selected: picked.has(node.id) })));
    setEdges((current) => current.map((edge) => (edge.selected === picked.has(edge.id) ? edge : { ...edge, selected: picked.has(edge.id) })));
  }, []);

  const selectedIds = useMemo(() => new Set(nodes.filter((node) => node.selected === true).map((node) => node.id)), [nodes]);
  const selectedLine = useMemo(() => edges.find((edge) => edge.selected === true), [edges]);
  const agentsPicked = draft.agents.filter((agent) => selectedIds.has(agent.member.id));
  const inputPicked = selectedIds.size === 1 ? draft.inputs.find((each) => selectedIds.has(each.input.id))?.input : undefined;
  const gatePicked = selectedIds.size === 1 ? draft.gates.find((each) => selectedIds.has(each.gate.id))?.gate : undefined;
  const linePicked = selectedLine === undefined ? undefined : draft.lines.find((line) => lineKey(line) === selectedLine.id);

  const join = useCallback(
    ({ source, target, sourceHandle }: Connection) => {
      let next = withLine(draft, source, target);
      if (next === draft) return;
      // Drawn from a loop gate's foot, a line back to an agent is its again line.
      if (sourceHandle === 'again' && next.agents.some((agent) => agent.member.id === target)) next = withLineSet(next, { from: source, to: target }, { way: 'again' });
      commit(next);
      const agent = next.agents.some((each) => each.member.id === target);
      toasts.show({ id: 'prefab-line', message: agent ? `Joined. ${startWord(next, target).text}.` : 'Joined.' });
    },
    [draft, commit, toasts],
  );

  const removeSelected = useCallback(() => {
    if (selectedIds.size > 0) {
      commit(withoutNodes(draft, [...selectedIds]));
      const what = selectedIds.size === 1 ? nodeName(draft, [...selectedIds][0]!) : `${selectedIds.size} things`;
      toasts.show({ id: 'prefab-delete', message: `Deleted ${what.replace(/^the /, '')}`, action: { label: 'Undo', onClick: undo, shortcut: '⌘Z' } });
    } else if (linePicked !== undefined) {
      commit(withoutLine(draft, linePicked));
      toasts.show({ id: 'prefab-delete', message: 'Deleted the line', action: { label: 'Undo', onClick: undo, shortcut: '⌘Z' } });
    }
  }, [selectedIds, linePicked, draft, commit, toasts, undo]);

  const paste = useCallback(
    (from: { agents: readonly BoardAgent[]; lines: readonly PrefabLine[] } | undefined) => {
      if (from === undefined || from.agents.length === 0) return;
      const copy = pasted(draft, from.agents, from.lines);
      picking.current = copy.ids;
      commit(copy.draft);
    },
    [draft, commit],
  );
  const picked = () => ({ agents: agentsPicked, lines: draft.lines.filter((line) => selectedIds.has(line.from) && selectedIds.has(line.to)) });
  const duplicate = () => paste(picked());

  /** Where a new thing of `size` goes: the middle of the view. */
  const centred = (size: { width: number; height: number }) => {
    const canvas = root.current?.querySelector('.prefab-board-canvas')?.getBoundingClientRect();
    const centre = canvas === undefined ? { x: 0, y: 0 } : screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 });
    return { x: Math.round(centre.x - size.width / 2), y: Math.round(centre.y - size.height / 2) };
  };
  /** Adds what `made` makes, selected. */
  const added = (made: { draft: BoardDraft; id: string }) => {
    picking.current = [made.id];
    commit(made.draft);
  };
  const add = (kind: AgentKind) => added(addAgent(draft, kind, centred(AGENT_TILE)));
  const addPill = (kind: PrefabInputKind) => added(addInput(draft, kind, centred(pillSize(kind))));

  const save = useCallback(async (): Promise<LibraryPrefab | false> => {
    if (problems.length > 0) {
      select([]);
      toasts.show({ id: 'prefab-save', tone: 'error', message: problems.length === 1 ? problems[0]!.text : `${problems[0]!.text} And ${problems.length - 1} more, in the panel.` });
      return false;
    }
    try {
      const done = await window.agentBoard.orchestrators.savePrefab(prefab, replaces ?? undefined, boardPlaces(draft));
      setReplaces(done.name);
      setSaved(draft);
      void refreshPrefabs();
      toasts.show({ id: 'prefab-save', tone: 'success', message: `Saved ${done.name}. It’s in + agent ▾ and Settings › Prefabs.` });
      if (agentDraft !== undefined) {
        setAgentDraft(undefined);
        dropDraft(agentDraft.id, `Saved ${done.name}, but`);
      }
      return done;
    } catch (failure) {
      toasts.show({ id: 'prefab-save', tone: 'error', message: `Could not save it: ${errorMessage(failure)}` });
      return false;
    }
  }, [problems, prefab, replaces, draft, select, toasts, agentDraft, dropDraft]);

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
    else if (pressed('edit.selectAll', event)) run(() => select(nodes.map((node) => node.id)));
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
    if (takesFocus && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
    if (start.toast !== undefined) toasts.show({ id: 'prefab-open', message: start.toast });
    // Once, as it opens.
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<BoardNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), current)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<LineEdge>[]) => setEdges((current) => applyEdgeChanges(changes.filter((change) => change.type !== 'remove'), current)), []);
  const change = (id: string, fields: MemberFields, field: string) =>
    commit((current) => ({ ...current, agents: current.agents.map((agent) => (agent.member.id === id ? { ...agent, member: changedMember(agent.member, fields) } : agent)) }), `${field}:${id}`);
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
          {['', '-on', '-warn', '-loop'].map((tone) => (
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
          minZoom={ZOOM_FLOOR}
          proOptions={{ hideAttribution: true }}
        >
          <BoardBackdrop gap={desk.gap} size={desk.size} />
        </ReactFlow>
        <div className="prefab-board-foot" ref={foot}>
        <Island className="prefab-board-dock" role="toolbar" aria-label="Add">
          <span className="prefab-board-dock-label">Add</span>
          <Menu entries={addMenu} side="top" align="center">
            <Button size="sm" variant="ghost" icon={<Plus />} data-testid="prefab-board-add">
              Agent
            </Button>
          </Menu>
          <IslandSeparator />
          {!draft.inputs.some((each) => each.input.kind === 'prompt') && (
            <Button size="sm" variant="ghost" icon={<Play />} onClick={() => addPill('prompt')}>
              Your prompt
            </Button>
          )}
          {DOCK_INPUTS.map(({ kind, label }) => {
            const { Icon } = INPUT_FACES[kind];
            return (
              <Button key={kind} size="sm" variant="ghost" icon={<Icon />} data-testid={`prefab-board-add-${kind}`} onClick={() => addPill(kind)}>
                {label}
              </Button>
            );
          })}
          <Button size="sm" variant="ghost" icon={<Repeat />} data-testid="prefab-board-add-gate" onClick={() => added(addGate(draft, centred(GATE_SIZE)))}>
            Loop gate
          </Button>
          <IslandSeparator />
          <Button size="sm" variant="ghost" icon={<Maximize />} onClick={() => fit(motionDuration(tokenNumber('--motion-base')))}>
            Fit
          </Button>
        </Island>
        <p className="prefab-board-hint">Drag from a tile’s right edge to draw a line. Click a line for what it carries, and a loop gate for its rule.</p>
        <p className="prefab-board-sentence" data-testid="prefab-board-sentence">
          <Info aria-hidden />
          <span>
            {boardSentence(draft).map((words, index) => (words.bold === true ? <b key={index}>{words.text}</b> : <span key={index}>{words.text}</span>))}
          </span>
        </p>
        </div>
        {agentDraft !== undefined && (
          <PrefabDraftNote
            ref={draftNote}
            assumptions={agentDraft.assumptions}
            drafter={agentDraft.drafter}
            summary={draftSummary(prefab, draft)}
            onSave={() => void save()}
            {...(onStart === undefined ? {} : { onStart: () => void save().then((done) => done !== false && onStart(done, agentDraft)) })}
            onDiscard={() => {
              dropDraft(agentDraft.id, 'Discarded, but');
              onLeave();
            }}
            onPick={(id) => select([id])}
          />
        )}
      </div>
      <aside className="prefab-board-side nodrag nowheel" aria-label="Change it" data-testid="prefab-board-side">
        {agentsPicked.length === 1 && selectedIds.size === 1 ? (
          <AgentPanel
            agent={agentsPicked[0]!}
            draft={draft}
            onChange={(fields, field) => change(agentsPicked[0]!.member.id, fields, field)}
            onDuplicate={duplicate}
            onDelete={removeSelected}
          />
        ) : agentsPicked.length > 1 && agentsPicked.length === selectedIds.size ? (
          <AgentsPanel agents={agentsPicked} onChange={(fields) => changeAll(agentsPicked.map((agent) => agent.member.id), fields)} onDuplicate={duplicate} onDelete={removeSelected} />
        ) : gatePicked !== undefined ? (
          <GatePanel key={gatePicked.id} draft={draft} gate={gatePicked} onChange={(gate) => commit((current) => withGate(current, gate), `gate:${gate.id}`)} onDelete={removeSelected} />
        ) : inputPicked !== undefined ? (
          <InputPanel
            input={inputPicked}
            onChange={(input) => commit((current) => withInput(current, input), `input:${input.id}`)}
            onKind={(kind) => commit((current) => withInputKind(current, inputPicked.id, kind))}
            onDelete={removeSelected}
          />
        ) : linePicked !== undefined ? (
          <LinePanel draft={draft} line={linePicked} onChange={(set) => commit((current) => withLineSet(current, linePicked, set))} onDelete={removeSelected} />
        ) : selectedIds.size > 0 ? (
          <ThingsPanel count={selectedIds.size} onDelete={removeSelected} />
        ) : (
          <PrefabPanel draft={draft} problems={problems} onChange={changePrefab} onGate={(gate) => commit((current) => withGate(current, gate))} />
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
                if (agentDraft !== undefined) dropDraft(agentDraft.id, 'Discarded, but');
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
              {agentDraft !== undefined && (
                <Button
                  variant="secondary"
                  data-testid="prefab-draft-keep"
                  onClick={() => {
                    setAsking(false);
                    onLeave();
                  }}
                >
                  Keep the draft
                </Button>
              )}
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
          {agentDraft !== undefined ? 'It’s a draft, not in the library yet. Keep it for later in Settings › Prefabs › Drafts, or discard it.' : 'It has changes you haven’t saved.'}
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

/** An input's pill: where work comes from (a dot on its right), Your OK (a dot each side), or an end (a dot on its left). */
function InputPill({ data: { input, warn }, selected }: NodeProps<InputNode>) {
  const { label, Icon } = inputFace(input);
  return (
    <div className="prefab-board-pill" data-kind={input.kind} data-selected={selected || undefined} data-warn={warn || undefined} data-testid={input.kind === 'prompt' ? 'prefab-prompt' : 'prefab-input'}>
      <Icon aria-hidden />
      {label}
      {!isSourceKind(input.kind) && <Handle type="target" id="in" position={Position.Left} className="prefab-handle" />}
      {input.kind !== 'end' && <Handle type="source" id="out" position={Position.Right} className="prefab-handle" />}
    </div>
  );
}

/** A loop gate: a diamond that asks "Again?", its rule on a chip above, what it waits for under it, its again line drawn from its foot. */
function GateDiamond({ data: { rule, wait, warn }, selected }: NodeProps<GateNode>) {
  return (
    <div className="prefab-gate" data-selected={selected || undefined} data-warn={warn || undefined} data-testid="prefab-gate">
      <span className="prefab-gate-rule">
        <Repeat aria-hidden />
        {rule}
      </span>
      <span className="prefab-gate-diamond" aria-hidden />
      <span className="prefab-gate-word">Again?</span>
      {wait !== null && (
        <span className="prefab-join prefab-gate-wait" data-testid="prefab-gate-wait">
          <Hourglass aria-hidden />
          {wait}
        </span>
      )}
      <Handle type="target" id="in" position={Position.Left} className="prefab-handle" />
      <Handle type="source" id="out" position={Position.Right} className="prefab-handle" />
      <Handle type="source" id="again" position={Position.Bottom} className="prefab-handle" />
    </div>
  );
}

/** An agent of the prefab, drawn in the board's tile design, with the start it has, its brief, how it joins and its branch. */
function AgentTile({ data: { member, word, own, badge, branch, warn }, selected }: NodeProps<AgentNode>) {
  const design = useTileDesign();
  const style = useCharacterStyle();
  const label = memberLabel(member);
  const pose = poseOf(member);
  const brief = member.brief?.trim();
  const now =
    brief !== undefined && brief !== '' ? (
      <q className="prefab-brief">{brief}</q>
    ) : member.template !== null && member.template.trim() !== '' ? (
      `“${member.template.trim().split('\n')[0]}”`
    ) : (
      doesOf(member)
    );
  const wrong = word.warn === true || warn;
  // On the graph board the lines say what starts each agent: its foot says so only when that is wrong.
  const tags = (
    <>
      <Tag mono>{[member.harness, member.model, member.effort].filter((part) => part !== null).join(' · ')}</Tag>
      {member.role !== null && <Tag>{member.role === ORCHESTRATOR_ROLE ? 'lead' : member.role}</Tag>}
      {own && <Tag tone="accent">own prompt</Tag>}
    </>
  );
  // In the name's row, where there is room, not the tags', which a state word already fills.
  const branchTag = branch !== null && (
    <span className="prefab-branch" data-works={branch === 'crew branch' ? 'crew' : 'own'}>
      <GitBranch aria-hidden />
      {branch}
    </span>
  );
  const extras = (
    <>
      {badge !== null && (
        <span className="prefab-join" data-join={member.join === 'each' ? 'each' : 'all'} data-testid="prefab-join">
          {member.join === 'each' ? <FastForward aria-hidden /> : <Hourglass aria-hidden />}
          {badge}
        </span>
      )}
      <Handle type="target" id="in" position={Position.Left} className="prefab-handle" />
      <Handle type="source" id="out" position={Position.Right} className="prefab-handle" />
      <Handle type="target" id="back" position={Position.Bottom} className="prefab-handle prefab-handle-back" />
    </>
  );
  const common = { 'data-testid': 'prefab-agent', 'data-selected': selected || undefined, 'data-warn': wrong || undefined, 'data-harness': member.harness, 'data-member': member.id };
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
            {branchTag}
          </div>
          <span className="shelf-tile-line">{now}</span>
          <div className="shelf-tile-meta">{tags}</div>
        </div>
        {wrong && (
          <div className="shelf-tile-band" data-level="2">
            <AlertTriangle aria-hidden className="shelf-tile-glyph" />
            <span className="shelf-tile-word">{word.text}</span>
          </div>
        )}
        {extras}
      </div>
    );
  }
  return (
    <div className="hybrid-tile hybrid-tile-agent glance-tile porthole-tile prefab-agent" {...common}>
      <div className="porthole-name">
        <span className="hybrid-tile-name">{label}</span>
        {branchTag}
      </div>
      <div className="porthole-body">
        <span className="porthole-port" data-ring={wrong ? 'ask' : undefined} data-look={style === 'off' ? 'icons' : style}>
          {style === 'off' ? <RoleIcon member={member} /> : <TileCharacter harness={member.harness} pose={pose} style={style} height={25} />}
        </span>
        {typeof now === 'string' ? <GlanceLine line={{ text: now, command: false }} className="porthole-line" /> : <span className="porthole-line">{now}</span>}
      </div>
      <span className="porthole-meta">
        {wrong && (
          <span className="porthole-state">
            <span className="porthole-word" data-tone="chip">
              <AlertTriangle aria-hidden className="porthole-word-glyph" />
              <span className="prefab-word">{word.text}</span>
            </span>
          </span>
        )}
        {tags}
      </span>
      {extras}
    </div>
  );
}

/**
 * A line: a curve from one dot to the next; a loop gate's again line an arc under the loop, from the gate's foot back
 * to its head's; a lead's dotted.
 */
function Line({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<LineEdge>) {
  const kind = data?.kind ?? 'plain';
  let path: string;
  let labelX: number;
  let labelY: number;
  if (kind === 'again') {
    const depth = data?.depth ?? againDepth(targetX - sourceX);
    const bottom = Math.max(sourceY, targetY) + depth;
    path = `M ${sourceX} ${sourceY} C ${sourceX} ${bottom}, ${targetX} ${bottom}, ${targetX} ${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = Math.max(sourceY, targetY) + depth * 0.75;
  } else [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const tone = selected === true ? '-on' : data?.warn === true ? '-warn' : kind === 'again' ? '-loop' : '';
  return (
    <>
      <BaseEdge id={id} path={path} className="prefab-line" data-kind={kind} data-selected={selected || undefined} data-warn={data?.warn} markerEnd={`url(#prefab-arrow${tone})`} interactionWidth={16} />
      {data?.label !== undefined && (
        <EdgeLabelRenderer>
          <span className="prefab-line-label" data-kind={kind} data-selected={selected || undefined} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { pill: InputPill, agent: AgentTile, gate: GateDiamond };
const EDGE_TYPES = { line: Line };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prefab-side-field">
      <span className="prefab-side-label">{label}</span>
      {children}
    </div>
  );
}

/** A whole number from `min` to `max`, typed: kept as typed while it is out of bounds, and set once it is in them. */
function NumberField({ value, min, max, label, disabled, onChange }: { value: number; min: number; max: number; label: string; disabled?: boolean; onChange(value: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Input
      type="number"
      className="prefab-number"
      aria-label={label}
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const number = Number(event.target.value);
        if (event.target.value !== '' && Number.isInteger(number) && number >= min && number <= max) onChange(number);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** A timeout: off, or on after so many minutes, the number inline in the words for it. */
function Timeout({ value, label, words, after = 'minutes', onChange }: { value: number | null | undefined; label: string; words: string; after?: string; onChange(value: number | null): void }) {
  const on = value !== null && value !== undefined;
  return (
    <span className="prefab-side-inline">
      <Checkbox label={words} checked={on} onChange={(event) => onChange(event.target.checked ? DEFAULT_GATE_TIMEOUT : null)} />
      <NumberField label={label} value={value ?? DEFAULT_GATE_TIMEOUT} min={MIN_PREFAB_TIMEOUT} max={MAX_PREFAB_TIMEOUT} disabled={!on} onChange={onChange} />
      <span>{after}</span>
    </span>
  );
}

function PrefabPanel({ draft, problems, onChange, onGate }: { draft: BoardDraft; problems: readonly BoardProblem[]; onChange(fields: Partial<BoardDraft>, field?: string): void; onGate(gate: PrefabGate): void }) {
  const icons = ICONS.includes(draft.icon as never) ? ICONS : [draft.icon, ...ICONS];
  // With one loop gate, the round limit is its, as the library reads it: Stop after is that gate's limit, when it goes
  // round until done. With more, each sets its own, so a crew-wide Stop after would mislead.
  const first = draft.gates.length === 1 ? draft.gates[0]!.gate : undefined;
  const loop = first?.rule === 'done' ? first : undefined;
  const stopAfter = loop?.rule === 'done' ? (loop.cap ?? MAX_REVIEW_CAP) : draft.roundLimit;
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
        <Textarea aria-label="What it’s for" rows={3} maxLength={MAX_PURPOSE} value={draft.purpose} onChange={(event) => onChange({ purpose: event.target.value }, 'purpose')} />
      </Field>
      {(loop !== undefined || draft.gates.length === 0) && (
      <Field label="Stop after">
        <Select
          aria-label="Stop after"
          value={String(stopAfter)}
          onChange={(event) => (loop?.rule === 'done' ? onGate({ ...loop, cap: Number(event.target.value) }) : onChange({ roundLimit: Number(event.target.value) }))}
        >
          {Array.from({ length: MAX_REVIEW_CAP }, (_, index) => index + 1).map((rounds) => (
            <option key={rounds} value={rounds}>
              {rounds} {rounds === 1 ? 'round' : 'rounds'}
            </option>
          ))}
        </Select>
      </Field>
      )}
      {draft.gates.length > 1 && <span className="prefab-side-hint">Each loop gate has its own limit: select one to change it.</span>}
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
              <li key={problem.text}>
                <AlertTriangle aria-hidden />
                {problem.text}
              </li>
            ))}
          </ul>
        )}
      </Field>
      <p className="prefab-side-note">Select an agent, a pill, a loop gate or a line to change it. Box-select several agents to set them all at once.</p>
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

function EffortRow({ value, members, onChange }: { value: Effort | null; members: readonly PrefabMember[]; onChange(effort: Effort): void }) {
  return <Segmented<Effort> className="prefab-efforts" aria-label="Reasoning" value={value ?? ('' as Effort)} onChange={onChange} options={sharedEfforts(members).map((effort) => ({ id: effort, label: EFFORT_SHORT[effort] }))} />;
}

function AgentPanel({ agent, draft, onChange, onDuplicate, onDelete }: { agent: BoardAgent; draft: BoardDraft; onChange(fields: MemberFields, field: string): void; onDuplicate(): void; onDelete(): void }) {
  const { member } = agent;
  const style = useCharacterStyle();
  const own = !listedRole(member.role);
  const lead = fromPrompt(draft, member.id);
  const word = startWord(draft, member.id);
  const lines = linesIn(draft, member.id);
  const fresh = member.fresh ?? defaultFresh(member.role);
  const works = member.works ?? defaultWorks(member.role);
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
        <ModelSelect value={modelChoice(member.harness, member.model)} harness={member.harness} model={member.model} onChange={(harness, model) => onChange({ harness, model, effort: effortOn(harness, member.effort) }, 'model')} />
      </Field>
      <Field label="Reasoning">
        <EffortRow value={member.effort} members={[member]} onChange={(effort) => onChange({ effort }, 'effort')} />
      </Field>
      <Field label="Brief">
        <Textarea
          aria-label="Brief"
          rows={2}
          placeholder="What kind of agent it is: “A terse reviewer who reads the tests first.”"
          value={member.brief ?? ''}
          onChange={(event) => onChange({ brief: event.target.value === '' ? undefined : event.target.value }, 'brief')}
        />
        <span className="prefab-side-hint">Free text, any length · it starts with this, then the crew’s prompt</span>
      </Field>
      <Field label="Each round">
        <Segmented
          aria-label="Each round"
          value={fresh ? 'fresh' : 'same'}
          onChange={(value) => onChange({ fresh: value === 'fresh' === defaultFresh(member.role) ? undefined : value === 'fresh' }, 'fresh')}
          options={[
            { id: 'fresh', label: 'A fresh agent' },
            { id: 'same', label: 'The same one' },
          ]}
        />
      </Field>
      {isMakerRole(member.role) && (
        <Field label="Works on">
          <Segmented
            aria-label="Works on"
            value={works}
            onChange={(value) => onChange({ works: value === defaultWorks(member.role) ? undefined : value }, 'works')}
            options={[
              { id: 'own', label: 'Its own branch' },
              { id: 'crew', label: 'The crew branch' },
            ]}
          />
          <span className="prefab-side-hint">
            {works === 'own' ? 'Its branch starts from the crew branch, when it starts, and its work comes back to it.' : 'It works on the crew branch, with every agent here that does.'}
          </span>
        </Field>
      )}
      {joinCount(draft, member.id) >= 2 && (
        <Field label="Inputs">
          <Segmented
            aria-label="Inputs"
            value={member.join ?? 'all'}
            onChange={(value) => onChange(value === 'all' ? { join: undefined } : { join: value, timeout: undefined }, 'join')}
            options={[
              { id: 'all', label: 'Wait for all' },
              { id: 'each', label: 'Each as it comes' },
            ]}
          />
          {member.join !== 'each' && <Timeout label="Minutes to wait" words="If one is late, go on after" value={member.timeout} onChange={(timeout) => onChange({ timeout: timeout ?? undefined }, 'timeout')} />}
          <span className="prefab-side-hint">Lines in: {lines.map((line) => nodeName(draft, line.from)).join(', ')}</span>
        </Field>
      )}
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
        <span>{lines.length > 0 ? 'To change it, move its line.' : 'Drag from a dot to join it.'}</span>
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
          onChange={(harness, model) => onChange((member) => ({ harness, model, effort: effortOn(harness, member.effort) }))}
        />
      </Field>
      <Field label="Reasoning">
        <EffortRow value={efforts.size === 1 ? first.effort : null} members={members} onChange={(effort) => onChange((member) => ({ effort: effortOn(member.harness, effort) }))} />
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

const CARRIES = [
  { id: 'none', label: 'Nothing: it only starts it' },
  { id: 'handoff', label: 'Its hand-off' },
  { id: 'review', label: 'Its review' },
] as const;

function LinePanel({ draft, line, onChange, onDelete }: { draft: BoardDraft; line: PrefabLine; onChange(set: { way?: 'again' | 'done'; carries?: PrefabLine['carries'] }): void; onDelete(): void }) {
  const gate = draft.gates.some((each) => each.gate.id === line.from);
  const member = draft.agents.some((agent) => agent.member.id === line.from);
  const toMember = draft.agents.some((agent) => agent.member.id === line.to);
  return (
    <>
      <h2 className="prefab-side-title">Line</h2>
      <div className="prefab-startbox">
        <span>{lineWords(draft, line)}</span>
      </div>
      {gate && (
        <Field label="Way out">
          <Segmented
            aria-label="Way out"
            value={line.way ?? 'done'}
            onChange={(way) => onChange({ way })}
            disabled={!toMember}
            options={[
              { id: 'again', label: 'Again' },
              { id: 'done', label: 'Done' },
            ]}
          />
          <span className="prefab-side-hint">A loop gate has one again line, back to the start of its loop. Its done lines go on.</span>
        </Field>
      )}
      {member && line.lead !== true && (
        <Field label="Carries">
          <Select aria-label="Carries" value={line.carries ?? 'none'} onChange={(event) => onChange({ carries: event.target.value === 'none' ? undefined : (event.target.value as PrefabLine['carries']) })}>
            {CARRIES.map((carries) => (
              <option key={carries.id} value={carries.id}>
                {carries.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="prefab-side-actions">
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete line <Kbd>⌫</Kbd>
        </Button>
      </div>
    </>
  );
}

function GatePanel({ draft, gate, onChange, onDelete }: { draft: BoardDraft; gate: PrefabGate; onChange(gate: PrefabGate): void; onDelete(): void }) {
  const deciders = decidersOf(draft, gate.id);
  // What it does at its limit, kept while it goes round a set number, so switching back to Until done finds it as it was.
  const atCap = useRef<'ask' | 'on'>(gate.rule === 'done' ? gate.atCap : 'ask');
  if (gate.rule === 'done') atCap.current = gate.atCap;
  return (
    <>
      <h2 className="prefab-side-title">Loop gate</h2>
      <p className="prefab-side-note">After the agents that decide, it sends the work back round its loop, or on.</p>
      <Field label="Goes round">
        <Segmented
          aria-label="Goes round"
          value={gate.rule}
          onChange={(rule) =>
            onChange(
              rule === 'rounds'
                ? { id: gate.id, rule, rounds: gate.rule === 'done' ? Math.min(gate.cap ?? MAX_GATE_ROUNDS, MAX_GATE_ROUNDS) : gate.rounds, timeout: gate.timeout }
                : { id: gate.id, rule, cap: gate.rule === 'rounds' ? Math.min(gate.rounds, MAX_REVIEW_CAP) : gate.cap, atCap: atCap.current, timeout: gate.timeout },
            )
          }
          options={[
            { id: 'done', label: 'Until done' },
            { id: 'rounds', label: 'A set number' },
          ]}
        />
      </Field>
      {gate.rule === 'rounds' && (
        <Field label="Rounds">
          <span className="prefab-side-inline">
            <NumberField label="Rounds" value={gate.rounds} min={1} max={MAX_GATE_ROUNDS} onChange={(rounds) => onChange({ ...gate, rounds })} />
            <span>{gate.rounds === 1 ? 'round' : 'rounds'}</span>
          </span>
        </Field>
      )}
      <Field label="Who decides">
        {deciders.length === 0 ? (
          <span className="prefab-side-hint">No one yet: draw a line from an agent to the gate.</span>
        ) : (
          <span className="prefab-side-chips">
            {deciders.map((member) => (
              <Tag key={member.id}>{memberLabel(member)}</Tag>
            ))}
          </span>
        )}
        <span className="prefab-side-hint">Every line into the loop gate is a decider. A reviewer’s approve is done, its changes is again.</span>
      </Field>
      <Field label="If one is late">
        <Timeout label="Minutes to wait for a word" words="Go on after" after="minutes, counting the missing one as again" value={gate.timeout} onChange={(timeout) => onChange({ ...gate, timeout })} />
      </Field>
      {gate.rule === 'done' && (
        <>
          <Field label="At most">
            <span className="prefab-side-inline">
              <NumberField label="Most rounds" value={gate.cap ?? MAX_REVIEW_CAP} min={1} max={MAX_REVIEW_CAP} disabled={gate.cap === null} onChange={(cap) => onChange({ ...gate, cap })} />
              <span>rounds</span>
              <Checkbox label="No limit" checked={gate.cap === null} onChange={(event) => onChange({ ...gate, cap: event.target.checked ? null : MAX_REVIEW_CAP })} />
            </span>
            {gate.cap === null && <span className="prefab-side-hint">With no limit it goes round until the deciders say done, however long that takes.</span>}
          </Field>
          {gate.cap !== null && (
            <Field label="At its limit">
              <Segmented
                aria-label="At its limit"
                value={gate.atCap}
                onChange={(atCap) => onChange({ ...gate, atCap })}
                options={[
                  { id: 'ask', label: 'Stop and ask me' },
                  { id: 'on', label: 'Go on out' },
                ]}
              />
              <span className="prefab-side-hint">Stop and ask is today’s round limit: One more round, Take over or Stop crew.</span>
            </Field>
          )}
        </>
      )}
      <div className="prefab-side-actions">
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete <Kbd>⌫</Kbd>
        </Button>
      </div>
    </>
  );
}

const INPUT_NOTES: Record<PrefabInputKind, string> = {
  prompt: 'What you type as you start the crew. Draw it to the agent that starts.',
  user: 'The crew waits here until you say go on.',
  queue: 'Each job on the zone’s queue starts the agents it goes to.',
  ticket: 'The ticket the crew is started for.',
  clock: 'On its schedule, it starts the agents it goes to with its line.',
  end: 'Where the crew stops.',
};

/** The Kind control's words for each kind a pill that brings work in can be. */
const SOURCE_LABELS: Record<SourceKind, string> = { prompt: 'You', queue: 'Queue', ticket: 'Ticket', clock: 'Clock' };

function InputPanel({ input, onChange, onKind, onDelete }: { input: PrefabInput; onChange(input: PrefabInput): void; onKind(kind: SourceKind): void; onDelete(): void }) {
  return (
    <>
      <h2 className="prefab-side-title">{inputFace(input).label}</h2>
      <p className="prefab-side-note">{INPUT_NOTES[input.kind]}</p>
      {isSourceKind(input.kind) && (
        <Field label="Kind">
          <Segmented aria-label="Kind" value={input.kind} onChange={onKind} options={SOURCE_KINDS.map((kind) => ({ id: kind, label: SOURCE_LABELS[kind] }))} />
        </Field>
      )}
      {input.kind === 'clock' && (
        <>
          <Field label="When">
            <Select aria-label="When" value={input.schedule} onChange={(event) => onChange({ ...input, schedule: event.target.value })}>
              {!CLOCK_SCHEDULES.some((each) => each.value === input.schedule) && <option value={input.schedule}>{input.schedule}</option>}
              {CLOCK_SCHEDULES.map((each) => (
                <option key={each.value} value={each.value}>
                  {each.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Its line">
            <Input aria-label="Its line" value={input.line} maxLength={MAX_PURPOSE} onChange={(event) => onChange({ ...input, line: event.target.value })} />
          </Field>
        </>
      )}
      {input.kind === 'end' && (
        <Field label="Ends">
          <Segmented
            aria-label="Ends"
            value={input.as}
            onChange={(as) => onChange({ ...input, as })}
            options={[
              { id: 'ready', label: 'Ready to merge' },
              { id: 'done', label: 'Done' },
            ]}
          />
        </Field>
      )}
      <div className="prefab-side-actions">
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete <Kbd>⌫</Kbd>
        </Button>
      </div>
    </>
  );
}

/** More than one thing selected, not all agents: they can only go together. */
function ThingsPanel({ count, onDelete }: { count: number; onDelete(): void }) {
  return (
    <>
      <h2 className="prefab-side-title">{count} selected</h2>
      <p className="prefab-side-note">Select agents alone to set them all at once.</p>
      <div className="prefab-side-actions">
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete {count}
        </Button>
      </div>
    </>
  );
}

/** The icons a prefab picks from, for other places that offer the same row. */
export const PREFAB_ICONS = ICONS;

/** Fit shows the graph at no more than its own size, and zooms out no further than `min`, where a bigger graph starts at its top left and the rest is a pan away; the canvas itself zooms out to `ZOOM_FLOOR`. */
const FIT_ZOOM = { min: 0.5, max: 1 } as const;
const ZOOM_FLOOR = 0.1;

/** Fit's room at each side of the canvas: clear of the bar, the dock and the sentence over it. */
const fitRoom = (foot: number) => fitPadding({ inset: tokenNumber('--island-inset'), bar: tokenNumber('--island-height'), foot, margin: tokenNumber('--space-6') });
