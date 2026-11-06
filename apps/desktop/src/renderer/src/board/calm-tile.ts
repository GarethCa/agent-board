// What an agent's calm tile says under the Simplified design: its status, one grey line, and at most one button. Pure, so it
// is unit-tested; `CalmTile` draws it.

import { continuesOnCredits, isOrchestratorRole, needsYouKind, permissionPrompt, planPending, questionPrompt, statusLine, type Agent, type ChecksState, type NeedsYouShows, type Shell } from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { inRepoCheckout } from '@agent-board/daemon/gate-rules';
import { asksInWords, humanStatus, type HumanStatus, type ImplementerFacts } from '@agent-board/daemon/human-status';
import { HARNESSES } from '../harness';
import { stepsWaitLine, toolSummary } from '../../../shared/needs-you';
import { panesLabel } from '../session/panes';
import { STATE_LABELS } from '../states';
import { branchLine, effortText, modelLabel } from './AgentSetup';

/**
 * The calm tile's one button: what it does (`CalmTile` wires each kind to the board), its words, and whether it is filled.
 * Only one for an agent that needs the user is filled, so the board's filled buttons are the work waiting for them.
 */
export interface CalmAction {
  kind: 'open' | 'plan' | 'resume' | 'pull-request' | 'wake' | 'credits' | 'retry';
  label: string;
  prominent: boolean;
}

/** An agent's calm tile: its status, a grey line of what it is doing or asks (null for nothing to say), and its button. */
export interface CalmFace {
  status: HumanStatus;
  line: string | null;
  action: CalmAction | null;
}

/**
 * What the calm tile says about `agent`. The line is what it asks, its flag, its notice, why it has its status, or the status
 * line it keeps, the first there is; never its name or its task again.
 */
export function calmFace(agent: Agent, shows: NeedsYouShows, implementer?: ImplementerFacts | null): CalmFace {
  const { status, detail } = humanStatus(agent, shows, implementer);
  return { status, line: lineOf(agent, detail), action: actionOf(agent, shows, status) };
}

function lineOf(agent: Agent, detail: string | null): string | null {
  const { startup } = agent;
  if (startup !== null) return startup.failed ? startup.output || `${HARNESSES[agent.harness].label} exited` : `Starting ${HARNESSES[agent.harness].label}…`;
  // A permission comes before questions: it is what Needs you lists the agent for.
  const prompt = permissionPrompt(agent) ?? questionPrompt(agent);
  // Claude's question tool's call reads as its questions, not as a tool it wants to use.
  if (prompt?.questions != null) return toolSummary(prompt);
  if (prompt !== undefined) return `${prompt.toolName}: ${toolSummary(prompt)}`;
  if (agent.ask !== null) return agent.ask.card !== null ? `On a steps card: ${agent.ask.question}` : agent.ask.question;
  if (planPending(agent)) return `Plan to review: ${agent.plan.title}`;
  // Loose: a record from an older daemon has no steps wait at all.
  if (agent.stepsWait != null) return stepsWaitLine(agent.stepsWait);
  if (agent.flag !== null) return agent.flag.reason;
  if (agent.notice !== null) return agent.notice;
  if (detail !== null) return detail;
  return agent.status === null ? null : statusLine(agent.status);
}

function actionOf(agent: Agent, shows: NeedsYouShows, status: HumanStatus): CalmAction | null {
  if (status === 'needs-you') {
    const kind = needsYouKind(agent, shows);
    if (kind === 'permission') return filled('open', 'Review & allow');
    // Put on the board, it is answered on its card: the tile has no button for it.
    if (kind === 'asks') return agent.ask?.card != null ? null : filled('open', 'Answer');
    if (kind === 'plan') return filled('plan', 'Read the plan');
    if (agent.state === 'stopped-by-restart') return filled('resume', 'Resume');
    if (kind === null && agent.endedAt === null && agent.lastMessage !== null && asksInWords(agent.lastMessage)) return filled('open', 'Answer');
    if (kind === null && agent.pullRequests.some((pr) => pr.state === 'open')) return filled('pull-request', 'Review changes');
    return filled('open', 'Open');
  }
  if (agent.startup?.failed === true) return bordered('retry', 'Try again');
  if (agent.state === 'hibernated') return bordered('wake', 'Wake');
  if (continuesOnCredits(agent)) return bordered('credits', 'Continue on credits');
  return null;
}

const filled = (kind: CalmAction['kind'], label: string): CalmAction => ({ kind, label, prominent: true });
const bordered = (kind: CalmAction['kind'], label: string): CalmAction => ({ kind, label, prominent: false });

const CHECK_MARKS: Record<ChecksState, string> = { passing: ' ✓', failing: ' ✗', pending: ' …', none: '' };

/**
 * The calm tile's technical layer, one mono line that Show technical details adds: its AI, model and reasoning effort (when
 * not its harness's own), its branch (or that it
 * has no worktree of its own), its pull requests with their checks, its raw state, and once it has ended, its exit code.
 */
export function technicalLine(agent: Agent): string {
  const isolation = agent.plainFolder
    ? 'shared folder, no worktree'
    : inRepoCheckout(agent) && agent.branch === '' && !agent.master && !isOrchestratorRole(agent.roleName)
      ? 'repo checkout, no worktree'
      : `⑂ ${branchLine(agent)}`;
  return [
    HARNESSES[agent.harness].label,
    agent.model === null ? 'default model' : modelLabel(agent.model),
    ...[effortText(agent)].filter((text) => text !== null),
    isolation,
    ...agent.pullRequests.map((pr) => `PR #${pr.number}${CHECK_MARKS[pr.checks]}`),
    STATE_LABELS[agent.state],
    ...(agent.endedAt === null || agent.exitCode === null ? [] : [`exit ${agent.exitCode}`]),
  ].join(' · ');
}

/**
 * A shell's calm tile: a status only when there is one to give (a running shell has none, being a prompt rather than work),
 * a grey line for what a restart or its panes' ending left, and whether it offers Resume.
 */
export interface CalmShellFace {
  status: HumanStatus | null;
  line: string | null;
  resume: boolean;
}

/** The panes in its layout that haven't ended; an ended id for a pane since closed out of the layout counts for nothing. */
const livePanes = (shell: Pick<Shell, 'layout' | 'endedPanes'>): number => paneIds(shell.layout).filter((pane) => !shell.endedPanes.includes(pane)).length;

export function calmShellFace(shell: Pick<Shell, 'layout' | 'endedPanes' | 'stoppedPanes'>): CalmShellFace {
  if (shell.stoppedPanes.length > 0) return { status: 'needs-you', line: 'Stopped by a restart', resume: true };
  if (livePanes(shell) === 0) return { status: 'done', line: 'Every pane has ended', resume: false };
  return { status: null, line: null, resume: false };
}

/** The panes a shell has and how many are live, for the technical layer: "2 panes · 1 live". */
export function shellPanesLine(shell: Pick<Shell, 'layout' | 'endedPanes'>): string {
  const panes = paneIds(shell.layout).length;
  const live = livePanes(shell);
  return `${panesLabel(panes)}${live < panes ? ` · ${live} live` : ''}`;
}
