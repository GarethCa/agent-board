import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Bell, Check, ExternalLink, RotateCw, SquareTerminal, Webhook } from 'lucide-react';
import type { ExternalHooksStatus, SetupTool, ToolCheck, TrackerScope } from '@agent-board/daemon/protocol';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { HarnessMark } from '../board/HarnessMark';
import { errorMessage } from '../../../shared/errors';
import { Button, ErrorText, IconButton, Input, Switch, Tag } from '../ui';
import { readySummary, toolRow, type RowStatus } from './first-run';

/** Where to get each CLI. */
const INSTALL_GUIDES: Record<SetupTool, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex#installing-and-running-codex-cli',
  gh: 'https://cli.github.com',
};

/** What signs each CLI in, after its path: run in a shell tile, where the user can answer it. */
const SIGN_IN_ARGS: Record<SetupTool, string> = { claude: 'auth login', codex: 'login', gh: 'auth login --web' };

const LINEAR_KEYS_URL = 'https://linear.app/settings/account/security';

export interface ConnectStepProps {
  progress: ReactNode;
  /** Runs `command` in a new shell tile, setting onboarding aside until the user comes back. */
  onSignIn(command: string): void;
  onOpenLink(url: string): void;
  onLater(): void;
  onNext(): void;
}

/**
 * Onboarding's Connect step (mock Y): a checklist of what agent-board works with, each row checking itself when the
 * step opens and fixable in place. Nothing is required, so the count says how many are left as optional.
 */
export function ConnectStep({ progress, onSignIn, onOpenLink, onLater, onNext }: ConnectStepProps) {
  const [checks, setChecks] = useState<Partial<Record<SetupTool, ToolCheck>>>({});
  const [linear, setLinear] = useState<LinearState>({ status: 'checking' });
  const [hooks, setHooks] = useState<ExternalHooksStatus>();
  const [notifications, setNotifications] = useState<NotificationsState>();
  const [problem, setProblem] = useState<string>();
  /** The latest check asked of each CLI: an older one's answer, arriving after, is dropped. */
  const latest = useRef<Partial<Record<SetupTool, number>>>({});

  const check = useCallback((tool: SetupTool) => {
    const asked = (latest.current[tool] ?? 0) + 1;
    latest.current[tool] = asked;
    setChecks((current) => ({ ...current, [tool]: undefined }));
    const answer = (found: ToolCheck) => {
      if (latest.current[tool] === asked) setChecks((current) => ({ ...current, [tool]: found }));
    };
    // A check that fails reads as a CLI that could not be asked, never as one still being checked.
    window.agentBoard.setup.check(tool).then(answer, (error: unknown) => answer({ tool, found: true, path: tool, problem: `could not be checked: ${errorMessage(error)}` }));
  }, []);

  useEffect(() => {
    for (const tool of ['claude', 'codex', 'gh'] as const) check(tool);
    window.agentBoard.trackers.status('linear').then(
      async ({ connected }) => {
        if (!connected) return setLinear({ status: 'none' });
        const scopes = await window.agentBoard.trackers.scopes('linear');
        setLinear(scopes.status === 'ok' ? { status: 'connected', teams: scopes.scopes } : { status: 'none', refused: scopes.refused });
      },
      () => setLinear({ status: 'none' }),
    );
    window.agentBoard.external.hooksStatus().then(setHooks, () => setHooks(undefined));
    window.agentBoard.view.get(VIEW_KEYS.notificationsTested).then(
      (tested) => setNotifications(tested === true ? 'sent' : 'untested'),
      () => setNotifications('untested'),
    );
  }, [check]);

  // Claude Code is the one thing agent-board needs; the rest is optional.
  const statuses: RowStatus[] = [
    toolRow(checks.claude).status,
    toolRow(checks.codex).status,
    toolRow(checks.gh).status,
    linear.status === 'connected' ? 'ready' : linear.status === 'checking' ? 'checking' : 'missing',
    hooks === undefined ? 'checking' : hooks.enabled ? 'ready' : 'missing',
    notifications === undefined ? 'checking' : notifications === 'sent' ? 'ready' : 'missing',
  ];
  const summary = readySummary(statuses.map((status, index) => ({ status, required: index === 0 })));
  const testNotification = () => {
    window.agentBoard.setup.testNotification().then(
      async ({ shown }) => {
        if (!shown) return setNotifications('unsupported');
        await window.agentBoard.view.set(VIEW_KEYS.notificationsTested, true);
        setNotifications('sent');
      },
      (error: unknown) => setProblem(errorMessage(error)),
    );
  };

  return (
    <section className="onboarding-card onboarding-connect" role="dialog" aria-modal="true" aria-labelledby="onboarding-connect-title">
      <header className="onboarding-connect-head">
        <div className="onboarding-connect-intro">
          <h1 id="onboarding-connect-title" className="onboarding-title">
            Connect your tools
          </h1>
          <p>agent-board runs the CLIs you already use. Only Claude Code is needed to start; the rest is optional.</p>
        </div>
        <div className="onboarding-ready" role="status" data-testid="connect-summary">
          <ReadyRing ready={summary.ready} total={summary.total} />
          <span>
            <span className="onboarding-ready-title">{summary.title}</span>
            <span className="onboarding-ready-detail">{summary.detail}</span>
          </span>
        </div>
      </header>
      <ul className="onboarding-rows">
        <ToolRow tool="claude" name="Claude Code CLI" required icon={<HarnessMark harness="claude" />} check={checks.claude} onCheck={check} onSignIn={onSignIn} onOpenLink={onOpenLink} />
        <ToolRow tool="codex" name="Codex CLI" optional icon={<HarnessMark harness="codex" />} check={checks.codex} onCheck={check} onSignIn={onSignIn} onOpenLink={onOpenLink} />
        <ToolRow
          tool="gh"
          name={
            <>
              GitHub <code className="onboarding-row-code">gh</code>
            </>
          }
          label="GitHub"
          optional
          why="Needed for PRs, checks and GitHub zones."
          icon={<GitHubMark />}
          check={checks.gh}
          onCheck={check}
          onSignIn={onSignIn}
          onOpenLink={onOpenLink}
        />
        <LinearRow state={linear} onChange={setLinear} onOpenLink={onOpenLink} />
        <Row
          name="Global hooks"
          tag="opt-in"
          icon={<Webhook />}
          status={statuses[4]!}
          detail={
            <span>
              Shows sessions you start outside agent-board too. Adds hooks to <code>~/.claude/settings.json</code> and{' '}
              <code>~/.codex/hooks.json</code>, beside your own; turning it off takes them out again.
            </span>
          }
          action={
            <Switch
              label={hooks?.enabled ? 'On' : 'Off'}
              aria-label="Global hooks"
              checked={hooks?.enabled ?? false}
              disabled={hooks === undefined}
              onChange={(event) => {
                window.agentBoard.external.setHooksEnabled(event.target.checked).then(setHooks, (error: unknown) => setProblem(errorMessage(error)));
              }}
            />
          }
        />
        <Row
          name="Notifications"
          tag="optional"
          icon={<Bell />}
          status={statuses[5]!}
          detail={
            notifications === 'sent' ? (
              <>
                <code className="onboarding-row-state">test notification sent</code>
                <span>Didn&rsquo;t see it? Allow agent-board in your system&rsquo;s notification settings.</span>
              </>
            ) : notifications === 'unsupported' ? (
              <>
                <code className="onboarding-row-state">not supported here</code>
                <span>This system has no notifications agent-board can raise.</span>
              </>
            ) : (
              <>
                <code className="onboarding-row-state">not asked yet</code>
                <span>So you hear when an agent needs you. Your system asks the first time.</span>
              </>
            )
          }
          action={
            notifications === 'unsupported' ? undefined : (
              <Button onClick={testNotification}>{notifications === 'sent' ? 'Send again' : 'Allow'}</Button>
            )
          }
        />
      </ul>
      {problem !== undefined && <ErrorText className="onboarding-problem">{problem}</ErrorText>}
      <footer className="onboarding-foot" data-shaded>
        {progress}
        <span className="onboarding-foot-note">Help › Getting started brings this back</span>
        <span className="onboarding-foot-gap" />
        <Button size="lg" onClick={onLater}>
          Do this later
        </Button>
        <Button variant="primary" size="lg" trailingIcon={<ArrowRight />} onClick={onNext}>
          Continue
        </Button>
      </footer>
    </section>
  );
}

/** Whether a test notification was sent (the one that makes the OS ask), or this system can't show one. */
type NotificationsState = 'untested' | 'sent' | 'unsupported';

type LinearState = { status: 'checking' } | { status: 'none'; refused?: string } | { status: 'connected'; teams: TrackerScope[] };

interface RowProps {
  name: ReactNode;
  /** The row's accessible name, when `name` holds markup. */
  label?: string;
  tag?: string;
  icon: ReactNode;
  status: RowStatus;
  detail: ReactNode;
  action?: ReactNode;
  /** The detail sits under the row's own controls (Linear's key field), so the row aligns to its top. */
  tall?: boolean;
}

const STATUS_LABELS: Record<RowStatus, string> = { ready: 'Ready', action: 'Needs action', missing: 'Not set up', checking: 'Checking' };

function Row({ name, label, tag, icon, status, detail, action, tall = false }: RowProps) {
  return (
    <li className="onboarding-row" data-status={status} data-tall={tall || undefined} aria-label={label ?? (typeof name === 'string' ? name : undefined)}>
      <span className="onboarding-row-icon">{icon}</span>
      <div className="onboarding-row-body">
        <div className="onboarding-row-name">
          {name}
          {tag !== undefined && <Tag>{tag}</Tag>}
        </div>
        <div className="onboarding-row-detail">{detail}</div>
      </div>
      {action !== undefined && <div className="onboarding-row-action">{action}</div>}
      <span className="onboarding-badge" data-status={status} role="img" aria-label={STATUS_LABELS[status]}>
        {status === 'ready' && <Check />}
        {status === 'action' && <span className="onboarding-badge-bang">!</span>}
      </span>
    </li>
  );
}

interface ToolRowProps {
  tool: SetupTool;
  name: ReactNode;
  label?: string;
  optional?: boolean;
  /** Needed to start: tagged so, and counted apart from the optional rows. */
  required?: boolean;
  /** Why it matters, said when it isn't ready. */
  why?: string;
  icon: ReactNode;
  check: ToolCheck | undefined;
  onCheck(tool: SetupTool): void;
  onSignIn(command: string): void;
  onOpenLink(url: string): void;
}

/** A CLI's row: found where, which version, signed in; an install guide when missing, a sign-in when signed out. */
function ToolRow({ tool, name, label = typeof name === 'string' ? name : tool, optional = false, required = false, why, icon, check, onCheck, onSignIn, onOpenLink }: ToolRowProps) {
  const { status, detail } = toolRow(check);
  const missingWhy = why ?? `on your PATH. Add it to run ${tool === 'claude' ? 'Claude Code' : 'Codex'} agents.`;
  return (
    <Row
      name={name}
      label={label}
      tag={required ? 'required' : optional ? 'optional' : undefined}
      icon={icon}
      status={status}
      detail={
        <>
          <code className="onboarding-row-state">{detail}</code>
          {status === 'ready' && check?.found && <code className="onboarding-row-path" title={check.path}>
              {check.path}
            </code>}
          {status === 'missing' && <span>{missingWhy}</span>}
          {status === 'action' && why !== undefined && <span>{why}</span>}
        </>
      }
      action={
        status === 'missing' ? (
          <span className="onboarding-row-actions">
            <Button trailingIcon={<ExternalLink />} onClick={() => onOpenLink(INSTALL_GUIDES[tool])}>
              Install guide
            </Button>
            <IconButton variant="ghost" icon={<RotateCw />} aria-label={`Check ${label} again`} tooltip="Check again" onClick={() => onCheck(tool)} />
          </span>
        ) : status === 'action' && check?.found && check.problem === undefined ? (
          <span className="onboarding-row-stack">
            <Button icon={<SquareTerminal />} onClick={() => onSignIn(`${shellQuote(check.path)} ${SIGN_IN_ARGS[tool]}`)}>
              Sign in
            </Button>
            <span className="onboarding-row-hint">opens a shell tile</span>
          </span>
        ) : status === 'ready' || status === 'action' ? (
          <Button variant="ghost" size="sm" icon={<RotateCw />} onClick={() => onCheck(tool)}>
            Re-check
          </Button>
        ) : undefined
      }
    />
  );
}

/** Linear's row: paste an API key, test it, and see the teams it can reach. The key goes to the OS keychain only. */
function LinearRow({ state, onChange, onOpenLink }: { state: LinearState; onChange(state: LinearState): void; onOpenLink(url: string): void }) {
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [refused, setRefused] = useState<string>();
  const test = (event: FormEvent) => {
    event.preventDefault();
    setTesting(true);
    setRefused(undefined);
    window.agentBoard.trackers.connect('linear', key).then(
      (teams) => {
        setKey('');
        onChange({ status: 'connected', teams });
      },
      (error: unknown) => setRefused(errorMessage(error)),
    ).finally(() => setTesting(false));
  };
  const connected = state.status === 'connected';
  const why = refused ?? (state.status === 'none' ? state.refused : undefined);
  return (
    <Row
      name="Linear"
      tag="optional"
      tall
      icon={<LinearMark />}
      status={connected ? 'ready' : state.status === 'checking' ? 'checking' : 'missing'}
      detail={
        <>
          <form className="onboarding-linear" onSubmit={test}>
            <Input
              type="password"
              aria-label="Linear API key"
              placeholder={connected ? 'Stored in your keychain' : 'lin_api_…'}
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button type="submit" loading={testing} disabled={key.trim() === ''}>
              Test
            </Button>
          </form>
          {connected && (
            <span className="onboarding-row-detail onboarding-linear-result">
              <Check className="onboarding-ok-icon" />
              <span className="onboarding-ok">Teams {state.teams.map((team) => team.key).join(', ') || 'none yet'}</span>
              <span className="onboarding-row-quiet">key in your keychain</span>
            </span>
          )}
          {why !== undefined && <ErrorText className="onboarding-row-detail">{why}</ErrorText>}
        </>
      }
      action={
        <button type="button" className="onboarding-link" onClick={() => onOpenLink(LINEAR_KEYS_URL)}>
          Where&rsquo;s my key?
        </button>
      }
    />
  );
}

/** How much of the ring is green: the share of rows ready. */
function ReadyRing({ ready, total }: { ready: number; total: number }) {
  const circumference = 2 * Math.PI * 16;
  return (
    <svg className="onboarding-ring" viewBox="0 0 40 40" aria-hidden>
      <circle className="onboarding-ring-track" cx="20" cy="20" r="16" />
      {ready > 0 && (
      <circle
        className="onboarding-ring-fill"
        cx="20"
        cy="20"
        r="16"
        strokeDasharray={`${(circumference * ready) / Math.max(total, 1)} ${circumference}`}
        transform="rotate(-90 20 20)"
      />
      )}
    </svg>
  );
}

/** A path as one shell word, in any shell agent-board runs (sh, bash, zsh, fish). */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" className="onboarding-stroke-icon" aria-hidden>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

function LinearMark() {
  return (
    <svg viewBox="0 0 24 24" className="onboarding-stroke-icon onboarding-linear-mark" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 15.4 8.6 18.4M3.4 12.6l8 8M4.3 8.7l11 11" />
    </svg>
  );
}
