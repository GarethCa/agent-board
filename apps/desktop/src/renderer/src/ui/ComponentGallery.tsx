import type { ReactNode } from 'react';
import { AGENT_STATES, STICKY_COLORS, ZONE_COLOR_NAMES, ZONE_COLORS } from '@agent-board/daemon/protocol';
import {
  AlignStartVertical,
  BellOff,
  Bot,
  CalendarClock,
  Hand,
  MousePointer2,
  Shapes,
  StickyNote,
  Check,
  CircleDot,
  Copy,
  Expand,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Square,
  SquareArrowOutUpRight,
  SquareTerminal,
  Trash2,
  Type,
} from 'lucide-react';
import { themedColor } from '../board-colors';
import { HarnessMark } from '../board/HarnessMark';
import { Button, Chip, IconButton, Spinner, type ButtonVariant } from './Button';
import { Dialog } from './Dialog';
import { EditableName, RenameButton, type Renaming } from './EditableName';
import { EmptyState } from './EmptyState';
import { Island, IslandSeparator, ToolButton } from './Island';
import { PanelRow } from './PanelRow';
import { Section as PanelSection } from './Section';
import { Checkbox, Choice, Choices, ErrorText, Field, Fieldset, Hint, Input, Radio, Select, Swatch, SwatchRadio, Switch, Textarea } from './Field';
import { Badge, FlowPill, Kbd, SectionLabel, Shortcut, StatusPill, Tag } from './Label';
import { MenuPreview, type MenuEntry } from './Menu';
import { PopoverPreview } from './Popover';
import { Segmented } from './Segmented';
import { Tabs } from './Tabs';
import { ToastView } from './Toast';
import { TooltipPreview } from './Tooltip';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];
/** The states a control is drawn in: at rest, then held in each pointer and focus state, then disabled and loading. */
const STATES = ['rest', 'hover', 'active', 'focus', 'disabled', 'loading'] as const;
type State = (typeof STATES)[number];
const CHIP_STATES = ['rest', 'hover', 'active', 'focus', 'disabled'] as const;
const FIELD_STATES = ['rest', 'hover', 'focus', 'disabled', 'invalid'] as const;
const CHECK_STATES = ['off', 'on', 'hover', 'active', 'focus', 'disabled'] as const;

/** A control's props for one gallery state. */
const stateProps = (state: State) => ({
  'data-preview': ['hover', 'active', 'focus'].includes(state) ? state : undefined,
  disabled: state === 'disabled' || undefined,
});

const nothing = () => {};

/** A name's renaming state, held still for the gallery: not editing, and failing with `problem` if given. */
const renaming = (problem?: string): Renaming => ({ editing: false, problem, start: nothing, startSoon: nothing, commit: nothing, cancel: nothing });

const MENU: MenuEntry[] = [
  { label: 'Expand', icon: <Expand />, shortcut: '↵', onSelect: nothing },
  { label: 'Link issue…', icon: <CircleDot />, shortcut: 'L', onSelect: nothing },
  { label: 'Schedule…', icon: <CalendarClock />, onSelect: nothing },
  { label: 'Fork', icon: <GitBranch />, disabled: true, onSelect: nothing },
  'separator',
  { label: 'Stop session', icon: <Square />, danger: true, onSelect: nothing },
];

/** The board's context menu: a submenu, a row of colours, and a row with a hint. */
const CONTEXT_MENU: MenuEntry[] = [
  { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: nothing },
  { label: 'Align', icon: <AlignStartVertical />, entries: [] },
  'separator',
  {
    label: 'Note colour',
    swatches: STICKY_COLORS.slice(0, 5).map(({ name, value }, index) => ({ name, value, color: themedColor(value), pressed: index === 0 })),
    onPick: nothing,
  },
  'separator',
  { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, hint: 'Deleting a note only. Agents stay running.', onSelect: nothing },
];

/**
 * Every primitive in every state, for checking how they look: the Soft workbench (docs/adr/0008-design-system.md).
 * The app shows it at `#gallery`, and e2e/visual.spec.ts guards each section with a screenshot.
 */
export function ComponentGallery() {
  return (
    <div className="component-gallery" data-testid="component-gallery">
      <header className="component-gallery-head">
        <h1>Components</h1>
        <span>Soft workbench: 8px radius, soft fills and shadows, an accent-blue primary</span>
      </header>
      <Section id="buttons" title="Buttons">
        {(['md', 'sm'] as const).map((size) => (
          <StateGrid key={size} label={size === 'md' ? 'Medium' : 'Small'} rows={VARIANTS} states={STATES}>
            {(variant, state) => (
              <Button size={size} variant={variant} icon={size === 'sm' ? <Plus /> : undefined} {...stateProps(state)} loading={state === 'loading'}>
                {state === 'loading' ? 'Starting…' : size === 'md' ? 'Start agent' : 'New agent'}
              </Button>
            )}
          </StateGrid>
        ))}
        <StateGrid label="Icon buttons" rows={['secondary', 'ghost'] as const} states={STATES}>
          {(variant, state) => (
            <IconButton
              icon={variant === 'secondary' ? <SquareArrowOutUpRight /> : <MoreHorizontal />}
              aria-label={variant === 'secondary' ? 'Pop out' : 'More'}
              variant={variant}
              size={variant === 'secondary' ? 'md' : 'sm'}
              {...stateProps(state)}
              loading={state === 'loading'}
            />
          )}
        </StateGrid>
        <StateGrid label="Chips" rows={['plain', 'accent'] as const} states={CHIP_STATES}>
          {(tone, state) => (
            <Chip
              icon={tone === 'plain' ? <CircleDot /> : undefined}
              tone={tone === 'accent' ? 'accent' : undefined}
              mono={tone === 'accent'}
              data-preview={['hover', 'active', 'focus'].includes(state) ? state : undefined}
              aria-disabled={state === 'disabled' || undefined}
            >
              {tone === 'plain' ? 'issues' : 'ACME-58'}
            </Chip>
          )}
        </StateGrid>
        <Row label="Other">
          <Button variant="primary">
            Start agent
            <Kbd aria-hidden>⌘⏎</Kbd>
          </Button>
          <Button size="xs" icon={<CircleDot />}>
            Extra small
          </Button>
          <IconButton icon={<BellOff />} aria-label="Mute" aria-pressed />
          <Button icon={<Type />} aria-pressed>
            Pressed
          </Button>
          <Button variant="ghost" size="sm" aria-pressed>
            H1
          </Button>
          <Spinner />
        </Row>
      </Section>

      <Section id="fields" title="Fields">
        <div className="component-gallery-columns">
          <Field label="Agent name" hint="Names its branch and its tile.">
            <Input defaultValue="auth-refactor" />
          </Field>
          <Field label="With an icon">
            <Input placeholder="Search issues" icon={<Search />} />
          </Field>
          <Field label="Small">
            <Input size="sm" placeholder="Answer…" />
          </Field>
        </div>
        <StateGrid label="Text fields" rows={['Input', 'Select', 'Textarea'] as const} states={FIELD_STATES}>
          {(control, state) => {
            const props = {
              'data-preview': state === 'hover' || state === 'focus' ? state : undefined,
              disabled: state === 'disabled' || undefined,
              'aria-invalid': state === 'invalid' || undefined,
              'aria-label': `${control} ${state}`,
            };
            if (control === 'Input') return <Input defaultValue="auth-refactor" {...props} />;
            if (control === 'Select')
              return (
                <Select defaultValue="linear" {...props}>
                  <option value="linear">Linear</option>
                  <option value="github">GitHub</option>
                </Select>
              );
            return <Textarea rows={2} defaultValue="Make sessions movable between zones." {...props} />;
          }}
        </StateGrid>
        <ErrorText announce={false}>Could not reach Linear: the API key was refused.</ErrorText>
        <StateGrid label="Checks" rows={['Checkbox', 'Radio', 'Switch'] as const} states={CHECK_STATES}>
          {(name, state) => {
            const Control = { Checkbox, Radio, Switch }[name];
            return (
              <Control
                label={state}
                name={`${name}-${state}`}
                readOnly
                checked={state !== 'off' && state !== 'hover'}
                data-preview={state === 'hover' || state === 'active' || state === 'focus' ? state : undefined}
                disabled={state === 'disabled' || undefined}
              />
            );
          }}
        </StateGrid>
        <Choices aria-label="Harness">
          <Choice name="gallery-harness" label="Claude" detail="Claude Code CLI" mark={<HarnessMark harness="claude" />} readOnly checked />
          <Choice name="gallery-harness" label="Codex" detail="Codex CLI" mark={<HarnessMark harness="codex" />} readOnly checked={false} />
          <Choice name="gallery-harness" label="Hover" detail="Not picked" readOnly checked={false} data-preview="hover" />
        </Choices>
        <Row label="Tabs">
          <Tabs
            aria-label="Zone source"
            value="github"
            onChange={nothing}
            tabs={[
              { id: 'github', label: 'GitHub', count: 24 },
              { id: 'linear', label: 'Linear', count: 3 },
              { id: 'recent', label: 'Recent' },
            ]}
          />
        </Row>
        <Row label="Segmented">
          <Segmented
            aria-label="View"
            value="terminal"
            onChange={nothing}
            options={[
              { id: 'terminal', label: 'Terminal', icon: <SquareTerminal aria-hidden /> },
              { id: 'chat', label: 'Hover', icon: <MessageSquare aria-hidden />, preview: 'hover' },
              { id: 'focus', label: 'Focus', preview: 'focus' },
            ]}
          />
        </Row>
        <Row label="Swatches">
          {ZONE_COLORS.slice(0, 5).map((color, index) => (
            <Swatch key={color} color={color} aria-label={ZONE_COLOR_NAMES[color] ?? color} pressed={index === 0} onClick={nothing} />
          ))}
        </Row>
        <Row label="Swatch radios">
          {ZONE_COLORS.slice(0, 5).map((color, index) => (
            <SwatchRadio key={color} color={color} name="gallery-swatch" aria-label={ZONE_COLOR_NAMES[color] ?? color} readOnly checked={index === 0} />
          ))}
        </Row>
        <div className="component-gallery-columns">
          <Fieldset legend="Where it works">
            <Radio label="A worktree of its own" name="gallery-where" readOnly checked />
            <Radio label="Its own folder" name="gallery-where" readOnly checked={false} />
          </Fieldset>
          <Hint>A hint says what a control is for, outside a field.</Hint>
        </div>
        <Row label="Rename in place">
          <EditableName value="auth-refactor" renaming={renaming()} label="Agent name" />
          <RenameButton renaming={renaming()} />
          <EditableName value="not saved" renaming={renaming('Could not rename: the daemon is not running')} label="Agent name" />
        </Row>
      </Section>

      <Section id="overlays" title="Menu, popover, tooltip and toast">
        <div className="component-gallery-columns">
          <div className="component-gallery-stack">
            <MenuPreview entries={MENU} active="Link issue…" />
            <PopoverPreview aria-label="Zone tracker">
              <Field label="Linear team">
                <Select defaultValue="ACME">
                  <option value="ACME">Acme (ACME)</option>
                </Select>
              </Field>
            </PopoverPreview>
          </div>
          <MenuPreview entries={CONTEXT_MENU} active="Align" />
          <div className="component-gallery-stack">
            <TooltipPreview>
              Pop out
              <Kbd>⌘⇧O</Kbd>
            </TooltipPreview>
            <TooltipPreview>Run it on a schedule</TooltipPreview>
          </div>
          <div className="component-gallery-stack">
            <ToastView tone="success" message={<><b>acme-58-planner</b> handed off plan.md</>} action={{ label: 'Open', onClick: nothing }} onDismiss={nothing} />
            <ToastView tone="error" message="Could not add the zone: not a git repository" action={{ label: 'Retry', onClick: nothing }} onDismiss={nothing} />
            <ToastView tone="error" message="Buttons hovered" action={{ label: 'Retry', onClick: nothing }} onDismiss={nothing} preview="hover" />
            <ToastView tone="error" message="Buttons focused" action={{ label: 'Retry', onClick: nothing }} onDismiss={nothing} preview="focus" />
            <ToastView message="Zone bound to agent-board" onDismiss={nothing} />
          </div>
        </div>
      </Section>

      <Section id="labels" title="Badges, tags, state pills and keys">
        <Row label="Badges and tags">
          <Badge>3</Badge>
          <Badge tone="neutral">0</Badge>
          <Tag>Unbound zone</Tag>
          <Tag tone="accent" mono>
            ACME-58
          </Tag>
          <Tag mono>
            #208
            <span className="component-gallery-checks">
              <Check aria-hidden />
              12/12
            </span>
          </Tag>
        </Row>
        <Row label="Agent state pills">
          {AGENT_STATES.map((state) => (
            <StatusPill key={state} state={state} />
          ))}
        </Row>
        <Row label="Flow pills">
          <FlowPill>new</FlowPill>
          <FlowPill>sending now</FlowPill>
          <FlowPill>receiving…</FlowPill>
        </Row>
        <Row label="Shortcut hints">
          <Shortcut keys={['⌘', 'K']}>commands</Shortcut>
          <Shortcut keys={['N']}>sticky</Shortcut>
          <Shortcut keys={['esc']}>interrupt</Shortcut>
        </Row>
      </Section>

      <div className="component-gallery-columns" data-wide>
        <Section id="dialog" title="Dialog">
          <Dialog
            inline
            title={
              <>
                New Claude agent in <span className="new-agent-zone">agent-board</span>
              </>
            }
            aria-label="New agent preview"
            onClose={nothing}
            footer={
              <>
                <Button variant="ghost">Cancel</Button>
                <Button variant="primary">
                  Start
                  <Kbd aria-hidden>⌘⏎</Kbd>
                </Button>
              </>
            }
          >
            <Choices aria-label="Harness">
              <Choice name="dialog-harness" label="Claude" detail="Claude Code CLI" mark={<HarnessMark harness="claude" />} readOnly checked />
              <Choice name="dialog-harness" label="Codex" detail="Codex CLI" mark={<HarnessMark harness="codex" />} readOnly checked={false} />
            </Choices>
            <Field label="Task">
              <Textarea rows={3} defaultValue="Make sessions movable between zones without restarting the PTY." />
            </Field>
            <Field label="Name (optional)">
              <Input placeholder="From the task" />
            </Field>
          </Dialog>
        </Section>
        <Section id="empty" title="Empty state">
          <EmptyState
            className="component-gallery-empty"
            title="No agents in web-app yet"
            action={
              <Button size="sm" variant="primary" icon={<Plus />}>
                New agent
              </Button>
            }
          >
            Start one here, or drag a tile in from another zone.
          </EmptyState>
        </Section>
      </div>

      <Section id="window" title="In the session window">
        <div className="component-gallery-window" data-surface="window">
          <Row label="Controls">
            <Button size="sm" variant="primary">
              Send
            </Button>
            <Button size="sm">Interrupt</Button>
            <Button size="sm" data-preview="hover">
              Hover
            </Button>
            <Button size="sm" variant="danger">
              Stop
            </Button>
            <Button size="sm" disabled>
              Fork
            </Button>
            <IconButton icon={<SquareArrowOutUpRight />} aria-label="Pop out" size="sm" data-preview="focus" />
          </Row>
          <Input placeholder="Message auth-refactor…" />
        </div>
      </Section>

      <Section id="chrome" title="Chrome">
        <StateGrid label="Tools" rows={['tool'] as const} states={['rest', 'hover', 'active', 'focus', 'pressed'] as const}>
          {(_row, state) => (
            <ToolButton
              label="Sticky note"
              icon={<StickyNote />}
              shortcut="N"
              pressed={state === 'pressed' || undefined}
              data-preview={state === 'pressed' || state === 'rest' ? undefined : state}
            />
          )}
        </StateGrid>
        <Row label="Island">
          <Island role="toolbar" aria-label="Create">
            <ToolButton label="Select" icon={<MousePointer2 />} shortcut="V" pressed />
            <ToolButton label="Hand" icon={<Hand />} shortcut="H" />
            <IslandSeparator />
            <ToolButton label="Text" icon={<Type />} shortcut="T" />
            <ToolButton label="Shape" icon={<Shapes />} shortcut="S" />
            <IslandSeparator />
            <Button variant="primary" icon={<Plus />}>
              New agent
            </Button>
          </Island>
        </Row>
        <Row label="Sections">
          <div className="component-gallery-panel">
            <PanelSection label="Subagents" meta="1 active · 1 done">
              <PanelRow mark={<Bot aria-hidden />} name="test-writer" meta="12 tool uses · 2m 03s" end={<StatusPill state="running" />} />
              <PanelRow mark={<Bot aria-hidden />} name="docs-lookup" end={<StatusPill state="done" />} />
            </PanelSection>
            <PanelSection label="Schedule" meta="None" defaultOpen={false}>
              {null}
            </PanelSection>
          </div>
        </Row>
      </Section>
    </div>
  );
}

/** A primitive in a grid: one row per variant, one column per state. */
function StateGrid<Row extends string, Column extends string>({
  label,
  rows,
  states,
  children,
}: {
  label: string;
  rows: readonly Row[];
  states: readonly Column[];
  children(row: Row, state: Column): ReactNode;
}) {
  return (
    <div className="component-gallery-row">
      <SectionLabel as="h3">{label}</SectionLabel>
      <table className="component-gallery-grid">
        <thead>
          <tr>
            <th />
            {states.map((state) => (
              <th key={state}>{state}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <th>{row}</th>
              {states.map((state) => (
                <td key={state}>{children(row, state)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="component-gallery-section" data-testid={`gallery-${id}`} aria-label={title}>
      <SectionLabel as="h2">{title}</SectionLabel>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="component-gallery-row">
      <SectionLabel as="h3">{label}</SectionLabel>
      <div className="component-gallery-items">{children}</div>
    </div>
  );
}
