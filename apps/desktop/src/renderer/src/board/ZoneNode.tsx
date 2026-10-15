import { createContext, memo, useContext, useId, type CSSProperties, type ReactNode } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { CircleDot, Ellipsis, FileText, FolderGit2, FolderPlus, GitBranch, LayoutGrid, Link2, ListPlus, ListTodo, Network, Pencil, Plug, Plus, ShieldCheck, Unlink, X } from 'lucide-react';
import { Chip, EditableName, Menu, useRenaming, type MenuEntry } from '../ui';
import { folderLabel } from './folders';
import { leastZoneSize } from './layout';
import { CrewFramesContext } from './crew-view';
import { tokenNumber } from '../theme';
import { useZoneTabFold } from './zone-tab-fold';
import {
  MIN_ZONE_SIZE,
  TRACKER_PROVIDERS,
  ZONE_COLOR_NAMES,
  ZONE_COLORS,
  ZONE_FILL_OPACITY,
  type Zone,
  type ZoneBinding,
  type ZoneLayout,
} from '@agent-board/daemon/protocol';

/**
 * The part of the board, in board coordinates, a zone must cover to hold its tiles with room round them, and to be
 * at least its least size: left and top are Infinity with no tiles.
 */
export interface ZoneCovers {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * `covers` says what the zone must cover to hold the tiles the board has put in it where they are, and `tileCount`
 * how many there are: shrinking it past them packs them inward. `resizeMin` is how far the resize under way can go,
 * once a step of it found the tiles can be packed no tighter. `grown` marks a zone drawn bigger than it is stored.
 */
export type ZoneNodeType = Node<
  {
    zone: Zone;
    covers?: ZoneCovers;
    tileCount?: number;
    resizeMin?: { width?: number; height?: number };
    /** Grown for now round an expanded tile and the tiles it pushed aside: no snap target meanwhile. */
    grown?: true;
  },
  'zone'
>;

/** Persists a zone's layout once the user has finished moving or resizing it. */
export const SaveZoneLayoutContext = createContext<(id: string, layout: ZoneLayout) => void>(() => {});

/** What the board does as a zone is resized: its tiles are packed inward as it shrinks past them. */
export interface ZoneResize {
  /** A resize of the zone begins. */
  start(id: string): void;
  /** Whether the zone can take the layout `next`: false once its tiles can be packed no tighter, keeping those that fit. */
  resize(id: string, next: ZoneLayout): boolean;
}
export const ZoneResizeContext = createContext<ZoneResize>({ start: () => {}, resize: () => true });

/** Why a group with no default repo can't start an agent from an issue: there is no repo to ask for one in. */
const BIND_FIRST = 'Bind this zone to a repo, or give it a default repo, first';
/** Why a cloning zone's New agent button does nothing (S2). */
const AFTER_CLONE = 'Available after clone finishes';

/**
 * Why no agent can start in the zone with no repo picked for it: it is cloning, or a group with no default repo.
 * Undefined when one can.
 */
export function whyNoAgents(zone: Pick<Zone, 'clone' | 'repoRoot' | 'defaultRepo'>): string | undefined {
  if (zone.clone !== null) return AFTER_CLONE;
  return zone.repoRoot === null && zone.defaultRepo === null ? BIND_FIRST : undefined;
}

/** Stops a zone's clone; the zone goes with it. */
export const CancelCloneContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user for an issue from the zone's tracker, to put its card in the zone or start an agent from it. */
export const AddIssueContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user for a new agent's task, to start it in the zone. */
export const NewAgentContext = createContext<(zone: Zone) => void>(() => {});

/** Starts a shell tile in the zone: in its folder, or at home if it is unbound. */
export const NewShellContext = createContext<(zone: Zone) => void>(() => {});

/** Asks the user which tracker team or repo the zone's issues come from. */
export const ZoneTrackerContext = createContext<(zone: Zone) => void>(() => {});

/** The zone a dragged tile or note would move into if dropped now, which shows it is the drop target. */
export const DropTargetContext = createContext<string | undefined>(undefined);

/** Asks the user for a folder to bind an unbound zone to, as a repo or as a new project. */
export const BindZoneContext = createContext<(zone: Zone, as: ZoneBinding) => void>(() => {});

/**
 * What a zone's tab can do to the zone: to its binding, unbind it back into a group or set a group's default
 * repo; Tidy it; rename or recolour it, and delete it; turn the board MCP server off or on
 * for its agents.
 */
export interface ZoneBindingActions {
  unbind(zone: Zone): void;
  /** Asks for a group's default repo, to set or clear it. */
  pickDefaultRepo(zone: Zone): void;
  /** Lays its tiles out in rows, in reading order, and fits its height to them. */
  tidy(zone: Zone): void;
  /** Renames it; rejects if the daemon refuses. */
  rename(zone: Zone, name: string): Promise<unknown>;
  recolor(zone: Zone, color: string): void;
  /** Shows a fill opacity (a percent) on the zone as the slider is dragged, without saving it. */
  previewFill(zone: Zone, fillOpacity: number): void;
  /** Saves the fill opacity a drag ended on, as one step to undo, back to what the zone had before the drag. */
  setFill(zone: Zone, fillOpacity: number): void;
  /** Takes back a preview that is not to be saved: the zone is drawn as it was before the drag. */
  cancelFill(zone: Zone): void;
  /** Deletes a zone of any kind (after asking), leaving its tiles loose on the board where they are, and its notes and cards. */
  deleteZone(zone: Zone): void;
  /** Whether agents started in it get the board MCP server (ADR-0010). */
  setBoardMcp(zone: Zone, on: boolean): void;
  /** Lets the agents the user starts in the zone orchestrate there, or stops every agent in it orchestrating. */
  setAgentsOrchestrate(zone: Zone, on: boolean): void;
  /** Asks for the zone's gate command. */
  editGateCommand(zone: Zone): void;
  /** Opens the zone's role templates. */
  editRoleTemplates(zone: Zone): void;
}
export const ZoneBindingContext = createContext<ZoneBindingActions>({
  unbind: () => {},
  pickDefaultRepo: () => {},
  tidy: () => {},
  rename: () => Promise.resolve(),
  recolor: () => {},
  previewFill: () => {},
  setFill: () => {},
  cancelFill: () => {},
  deleteZone: () => {},
  setBoardMcp: () => {},
  setAgentsOrchestrate: () => {},
  editGateCommand: () => {},
  editRoleTemplates: () => {},
});

/** The fill opacity the theme gives a zone that has none of its own, in percent. */
function themeFillOpacity(): number {
  return tokenNumber('--zone-fill-default');
}

/** A chip on a zone's tab that can fold into its ⋯ menu. */
type ZoneTabChip = 'default-repo' | 'cancel-clone' | 'tracker' | 'issue' | 'bind' | 'agent' | 'shell' | 'tidy';

/** The tab's chips, the first to fold into ⋯ first when the zone is too narrow for them all. */
const FOLD_ORDER: readonly ZoneTabChip[] = ['tidy', 'issue', 'tracker', 'bind', 'default-repo', 'shell', 'agent', 'cancel-clone'];

/** A chip on the tab now, and what ⋯ offers in its place once it folds: nothing when ⋯ has it already. */
interface TabChip {
  key: ZoneTabChip;
  chip: ReactNode;
  entry: MenuEntry | undefined;
}

export function zoneNode(zone: Zone): ZoneNodeType {
  return {
    id: zone.id,
    type: 'zone',
    position: { x: zone.x, y: zone.y },
    width: zone.width,
    height: zone.height,
    data: { zone },
    // Moved by its tab or its bare body: its tiles and items are nodes of their own, drawn over it, so a press
    // on one moves only that, and its tab's buttons are `nodrag`. A marquee inside it starts with Shift held.
    zIndex: 0,
  };
}

/** A zone: a tinted region with a labelled tab, resizable from its edges once selected. */
export const ZoneNode = memo(function ZoneNode({
  data: { zone, tileCount = 0, resizeMin },
  selected,
  positionAbsoluteX,
  positionAbsoluteY,
  width,
  height,
}: NodeProps<ZoneNodeType>) {
  const saveLayout = useContext(SaveZoneLayoutContext);
  const resize = useContext(ZoneResizeContext);
  // Never smaller than rows of its tiles, nor than it is now if they already need more, nor than this resize can go.
  const rows = leastZoneSize(tileCount, { width: width ?? 0, height: height ?? 0 });
  const least = {
    width: resizeMin?.width ?? Math.min(rows.width, width ?? 0),
    height: resizeMin?.height ?? Math.min(rows.height, height ?? 0),
  };
  const newAgent = useContext(NewAgentContext);
  const newShell = useContext(NewShellContext);
  const pickTracker = useContext(ZoneTrackerContext);
  const bind = useContext(BindZoneContext);
  const binding = useContext(ZoneBindingContext);
  const cancelClone = useContext(CancelCloneContext);
  const addIssue = useContext(AddIssueContext);
  const dropTarget = useContext(DropTargetContext) === zone.id;
  const crews = useContext(CrewFramesContext).filter((frame) => frame.zoneId === zone.id);
  const unbound = zone.repoRoot === null;
  const { clone } = zone;
  // A group starts agents too: in its default repo, or one picked for each. Only a clone holds them back.
  const noAgents = clone === null ? undefined : whyNoAgents(zone);
  const whyNoAgentsId = useId();
  const renaming = useRenaming(zone.name, (name) => binding.rename(zone, name));
  const path =
    clone !== null
      ? `Cloning ${clone.repo} into ${clone.path}`
      : zone.repoRoot === null
      ? 'A group: bound to no repo'
      : zone.folder === ''
        ? zone.repoRoot
        : `${zone.repoRoot}/${zone.folder}`;
  const tracker = zone.tracker && { ...TRACKER_PROVIDERS[zone.tracker.provider], scope: zone.tracker.scope };
  const bindEntries = [
    { label: 'Open as repo…', icon: <GitBranch />, onSelect: () => bind(zone, 'repo') },
    { label: 'Open as project…', icon: <FolderPlus />, onSelect: () => bind(zone, 'project') },
    { label: 'Bind to a Linear team or GitHub repo…', icon: <ListTodo />, onSelect: () => pickTracker(zone) },
  ];
  // The chips on the tab now, in the order drawn, each with what ⋯ offers in its place once it folds.
  const chips: TabChip[] = [
    ...(zone.defaultRepo === null
      ? []
      : [
          {
            key: 'default-repo' as const,
            chip: (
              <Chip
                className="zone-tab-control zone-default-repo nodrag"
                icon={<GitBranch />}
                aria-label="Default repo"
                title={`New agents here start in ${zone.defaultRepo}`}
                onClick={() => binding.pickDefaultRepo(zone)}
              >
                {folderLabel(zone.defaultRepo, undefined)}
              </Chip>
            ),
            entry: {
              label: folderLabel(zone.defaultRepo, undefined),
              icon: <GitBranch />,
              hint: 'The default repo: new agents here start in it',
              onSelect: () => binding.pickDefaultRepo(zone),
            },
          },
        ]),
    ...(clone === null
      ? []
      : [
          {
            key: 'cancel-clone' as const,
            chip: (
              <Chip className="zone-tab-control nodrag" icon={<X />} aria-label="Cancel clone" onClick={() => cancelClone(zone)}>
                Cancel
              </Chip>
            ),
            entry: { label: 'Cancel clone', icon: <X />, danger: true, onSelect: () => cancelClone(zone) },
          },
        ]),
    {
      key: 'tracker',
      chip: (
        <Chip
          className="zone-tab-control nodrag"
          icon={<CircleDot />}
          aria-label="Zone tracker"
          title={tracker === null ? 'Pick where issues come from' : `Issues from ${tracker.name} ${tracker.scopeName} ${tracker.scope}`}
          onClick={() => pickTracker(zone)}
        >
          {zone.tracker === null ? 'issues' : zone.tracker.scope}
        </Chip>
      ),
      entry: {
        label: zone.tracker === null ? 'Pick where issues come from…' : `Issues from ${zone.tracker.scope}…`,
        icon: <CircleDot />,
        onSelect: () => pickTracker(zone),
      },
    },
    ...(zone.tracker === null
      ? []
      : [
          {
            key: 'issue' as const,
            chip: (
              <Chip
                className="zone-tab-control nodrag"
                icon={<ListPlus />}
                aria-label="Add issue"
                title={`Pick an issue from ${zone.tracker.scope}`}
                onClick={() => addIssue(zone)}
              >
                issue
              </Chip>
            ),
            entry: { label: 'Add issue…', icon: <ListPlus />, onSelect: () => addIssue(zone) },
          },
        ]),
    ...(unbound && clone === null
      ? [
          {
            key: 'bind' as const,
            chip: (
              <Menu entries={bindEntries}>
                <Chip className="zone-tab-control nodrag" icon={<Link2 />} aria-label="Bind zone" title="Bind this zone to a repo, or to a new project">
                  Bind…
                </Chip>
              </Menu>
            ),
            entry: { label: 'Bind…', icon: <Link2 />, entries: bindEntries },
          },
        ]
      : []),
    {
      key: 'agent',
      chip: (
        <>
          <Chip
            className="zone-tab-control nodrag"
            icon={<Plus />}
            aria-label="New agent"
            // Not `disabled`, which would take it out of the tab order and hide the tooltip saying why.
            aria-disabled={noAgents !== undefined}
            aria-describedby={noAgents === undefined ? undefined : whyNoAgentsId}
            title={noAgents}
            onClick={() => noAgents === undefined && newAgent(zone)}
          >
            agent
          </Chip>
          {noAgents !== undefined && (
            // The tooltip is for the mouse; this says the same to the keyboard and screen readers.
            <span id={whyNoAgentsId} className="visually-hidden">
              {noAgents}
            </span>
          )}
        </>
      ),
      entry: { label: 'New agent', icon: <Plus />, disabled: noAgents !== undefined, hint: noAgents, onSelect: () => newAgent(zone) },
    },
    {
      key: 'shell',
      chip: (
        <Chip className="zone-tab-control nodrag" icon={<Plus />} aria-label="New shell in zone" onClick={() => newShell(zone)}>
          shell
        </Chip>
      ),
      entry: { label: 'New shell', icon: <Plus />, onSelect: () => newShell(zone) },
    },
    {
      key: 'tidy',
      chip: (
        <Chip
          className="zone-tab-control nodrag"
          icon={<LayoutGrid />}
          aria-label="Tidy zone"
          title="Tidy: its tiles in rows, in reading order"
          onClick={() => binding.tidy(zone)}
        />
      ),
      // The zone's own ⋯ has Tidy already; while it clones, ⋯ holds only what folded.
      entry: clone === null ? undefined : { label: 'Tidy', icon: <LayoutGrid />, onSelect: () => binding.tidy(zone) },
    },
  ];
  const foldable = FOLD_ORDER.filter((key) => chips.some((chip) => chip.key === key));
  // What changes the tab's width without changing the zone's.
  const content = [zone.name, zone.tracker?.scope, zone.defaultRepo, clone?.phase, clone?.percent].join('\n');
  const { stripRef, tabRef, folded } = useZoneTabFold(foldable, content);
  // Each folded chip's action, at the head of ⋯, the most needed first.
  const foldedEntries = FOLD_ORDER.toReversed().flatMap((key) => {
    const entry = folded.has(key) ? chips.find((chip) => chip.key === key)?.entry : undefined;
    return entry === undefined ? [] : [entry];
  });
  return (
    <div
      className="zone"
      data-testid="zone"
      data-kind={zone.kind}
      data-cloning={clone !== null || undefined}
      data-drop-target={dropTarget || undefined}
      data-x={positionAbsoluteX}
      data-y={positionAbsoluteY}
      data-width={width}
      data-height={height}
      data-fill={zone.fillOpacity ?? undefined}
      style={{ '--zone-color': zone.color, '--zone-fill-pct': zone.fillOpacity ?? undefined } as CSSProperties}
    >
      {/* Under its tiles: each orchestrator's crew, framed beside it (BA2). */}
      {crews.map((frame) => (
        <div
          key={frame.orchestratorId}
          className="crew-frame"
          data-testid="crew-frame"
          data-orchestrator={frame.orchestratorId}
          data-members={frame.members.join(' ')}
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        >
          <span className="crew-frame-label">{frame.name}&apos;s crew</span>
        </div>
      ))}
      <NodeResizer
        // Grown round an expanded tile, it resizes from the size it is drawn at, and saves the size it is let go at.
        isVisible={selected}
        color={zone.color}
        minWidth={Math.max(MIN_ZONE_SIZE.width, least.width)}
        minHeight={Math.max(MIN_ZONE_SIZE.height, least.height)}
        onResizeStart={() => resize.start(zone.id)}
        // Shrinking past its tiles packs them inward as it goes, and stops once they fit no tighter.
        shouldResize={(_event, next) => resize.resize(zone.id, next)}
        onResizeEnd={(_event, { x, y, width, height }) => saveLayout(zone.id, { x, y, width, height })}
      />
      <div className="zone-tab-strip" ref={stripRef}>
        <div className="zone-tab" data-testid="zone-tab" title={path} ref={tabRef}>
          {unbound && clone === null && <span className="zone-tab-dot" aria-hidden="true" />}
          <span className="zone-tab-kind">{clone !== null ? 'clone' : unbound ? 'group' : zone.kind}</span>
          <EditableName className="zone-tab-name" value={zone.name} renaming={renaming} label="Zone name" />
          {clone !== null && (
            <span className="zone-clone" data-testid="zone-clone" role="status" aria-label={`Cloning ${clone.repo}`}>
              <span className="zone-clone-bar" aria-hidden="true">
                <span className="zone-clone-fill" style={{ width: `${clone.percent ?? 0}%` }} />
              </span>
              <span className="zone-clone-text">
                {clone.percent === null ? 'Cloning…' : `${clone.phase ?? 'Cloning'} · ${clone.percent}%`}
              </span>
            </span>
          )}
          {chips
            .filter(({ key }) => !folded.has(key))
            .map(({ key, chip }) => (
              <span key={key} className="zone-tab-slot" data-fold={key}>
                {chip}
              </span>
            ))}
          {clone !== null && foldedEntries.length > 0 && (
            <Menu entries={foldedEntries}>
              <Chip className="zone-tab-control nodrag" icon={<Ellipsis />} aria-label="Zone options" title="What doesn't fit on the tab" />
            </Menu>
          )}
          {clone === null && (
            <Menu
              entries={[
                ...(foldedEntries.length > 0 ? [...foldedEntries, 'separator' as const] : []),
                { label: 'Tidy', icon: <LayoutGrid />, hint: 'Its tiles in rows, in reading order', onSelect: () => binding.tidy(zone) },
                { label: 'Rename', icon: <Pencil />, onSelect: renaming.startSoon },
                {
                  label: 'Colour',
                  swatches: ZONE_COLORS.map((color) => ({ name: ZONE_COLOR_NAMES[color] ?? color, value: color, pressed: zone.color === color })),
                  onPick: (color: string) => binding.recolor(zone, color),
                },
                {
                  label: 'Fill opacity',
                  value: zone.fillOpacity ?? themeFillOpacity(),
                  ...ZONE_FILL_OPACITY,
                  format: (value: number) => `${value}%`,
                  onChange: (value: number) => binding.previewFill(zone, value),
                  onCommit: (value: number) => binding.setFill(zone, value),
                  onCancel: () => binding.cancelFill(zone),
                },
                unbound
                  ? {
                      label: zone.defaultRepo === null ? 'Set a default repo…' : 'Change the default repo…',
                      icon: <FolderGit2 />,
                      hint: 'New agents here start in it without asking',
                      onSelect: () => binding.pickDefaultRepo(zone),
                    }
                  : { label: 'Unbind', icon: <Unlink />, hint: 'Its agents keep their repos, and it keeps its issues', onSelect: () => binding.unbind(zone) },
                {
                  label: zone.boardMcp ? 'Turn off board MCP' : 'Turn on board MCP',
                  icon: <Plug />,
                  hint: zone.boardMcp
                    ? 'Agents started here stop getting the agent-board MCP server; the CLI stays'
                    : 'Agents started here get the agent-board MCP server again',
                  onSelect: () => binding.setBoardMcp(zone, !zone.boardMcp),
                },
                {
                  label: zone.agentsOrchestrate ? 'Stop agents orchestrating' : 'Let agents orchestrate',
                  icon: <Network />,
                  hint: zone.agentsOrchestrate
                    ? 'Stops every agent here orchestrating now'
                    : 'Agents you start here may start, message and close agents in this zone',
                  onSelect: () => binding.setAgentsOrchestrate(zone, !zone.agentsOrchestrate),
                },
                {
                  label: zone.gateCommand === null ? 'Set a gate command…' : 'Change the gate command…',
                  icon: <ShieldCheck />,
                  hint: zone.gateCommand ?? "What checks an agent's work before it is merged, run when you ask",
                  onSelect: () => binding.editGateCommand(zone),
                },
                {
                  label: 'Role templates…',
                  icon: <FileText />,
                  hint: 'What agents started here in a role begin with',
                  onSelect: () => binding.editRoleTemplates(zone),
                },
                'separator' as const,
                {
                  label: 'Delete zone…',
                  icon: <X />,
                  danger: true,
                  hint: 'Its tiles stay on the board where they are',
                  disabled: zone.clone !== null,
                  onSelect: () => binding.deleteZone(zone),
                },
              ]}
            >
              <Chip className="zone-tab-control nodrag" icon={<Ellipsis />} aria-label="Zone options" title="Tidy, rename, colour, default repo, unbind, board MCP, orchestrating, gate command, role templates, delete" />
            </Menu>
          )}
        </div>
      </div>
    </div>
  );
});
