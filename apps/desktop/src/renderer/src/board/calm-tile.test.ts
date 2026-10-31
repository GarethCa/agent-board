import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { calmFace, technicalLine } from './calm-tile';
import { galleryAgent } from './TileGallery';

const AT = '2026-10-22T12:00:00.000Z';

/** A plain agent at work, with nothing to say: the base each case changes. */
const working = (more: Partial<Agent> = {}): Agent => ({ ...galleryAgent('running'), subagents: [], pullRequests: [], ...more });

describe('calmFace', () => {
  it('says what a working agent is doing from its own status line, with no button', () => {
    const face = calmFace(working({ status: { summary: 'Running checks', progress: 66, updatedAt: AT, setBy: null } }), 'explicit');
    expect(face).toEqual({ status: 'working', line: 'Running checks · 66%', action: null });
  });

  it('leaves the line out when there is nothing to say, never repeating the name or the task', () => {
    expect(calmFace(working(), 'explicit')).toEqual({ status: 'working', line: null, action: null });
  });

  it('asks for permission in the tool’s own words, with one filled Review & allow', () => {
    const agent = working({
      state: 'needs-permission',
      permissions: [{ id: 'p', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, subagent: null, requestedAt: AT, heldUntil: null }],
    });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'needs-you', line: 'Bash: rm -rf dist', action: { kind: 'open', label: 'Review & allow', prominent: true } });
  });

  it('shows the question it asks, with a filled Answer', () => {
    const agent = working({ state: 'waiting', ask: { id: 'q', question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], freeText: true, askedAt: AT, expiresAt: AT, onBoard: false, at: { x: 0, y: 0 } } });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'needs-you', line: 'Postgres or SQLite?', action: { kind: 'open', label: 'Answer', prominent: true } });
  });

  it('points at a plan waiting for a decision, with a filled Read the plan', () => {
    const agent = working({ state: 'waiting', plan: { title: 'Selection strategy', decision: null } as Agent['plan'] });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'needs-you', line: 'Plan to review: Selection strategy', action: { kind: 'plan', label: 'Read the plan', prominent: true } });
  });

  it('offers Resume, filled, to an agent a restart stopped', () => {
    expect(calmFace(working({ state: 'stopped-by-restart', endedAt: AT }), 'explicit')).toEqual({
      status: 'needs-you',
      line: 'Stopped when the app restarted',
      action: { kind: 'resume', label: 'Resume', prominent: true },
    });
  });

  it('offers its open pull request for review once it has finished', () => {
    const agent = working({ state: 'idle', pullRequests: [{ number: 41, title: 'Add the dock', url: '', state: 'open', checks: 'passing' }] });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'needs-you', line: 'Changes ready to review', action: { kind: 'pull-request', label: 'Review changes', prominent: true } });
  });

  it('shows a flag’s reason and opens the agent', () => {
    const agent = working({ state: 'idle', flag: { id: 1, to: 'user', reason: 'Which port?', at: AT, via: null } });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'needs-you', line: 'Which port?', action: { kind: 'open', label: 'Open', prominent: true } });
  });

  it('gives a finished turn the user watches for an Open, with its status line as the line', () => {
    const agent = working({ state: 'waiting', status: { summary: 'Synced 214 books', progress: null, updatedAt: AT, setBy: null } });
    expect(calmFace(agent, 'turns')).toEqual({ status: 'needs-you', line: 'Synced 214 books', action: { kind: 'open', label: 'Open', prominent: true } });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'done', line: 'Synced 214 books', action: null });
  });

  it('wakes a paused agent with a bordered button, never a filled one', () => {
    const agent = working({ state: 'hibernated', endedAt: AT, hibernated: { at: AT, by: 'you', byId: null } });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'paused', line: null, action: { kind: 'wake', label: 'Wake', prominent: false } });
  });

  it('says why an agent is held for usage', () => {
    const agent = working({ state: 'hibernated', endedAt: AT, hibernated: { at: AT, by: 'Captain', byId: null, reason: 'weekly cap at 95%' } });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'paused', line: 'Paused for usage', action: { kind: 'wake', label: 'Wake', prominent: false } });
  });

  it('offers to continue on credits, bordered, while a usage limit stops it', () => {
    expect(calmFace(working({ state: 'rate-limited' }), 'explicit')).toEqual({
      status: 'paused',
      line: 'Usage limit',
      action: { kind: 'credits', label: 'Continue on credits', prominent: false },
    });
  });

  it('pauses a reviewer while the agent it reviews works, saying so', () => {
    const reviewer = working({ state: 'idle', reviewOf: 'impl' });
    expect(calmFace(reviewer, 'explicit', { name: 'Fix login redirect', state: 'running', endedAt: null })).toEqual({ status: 'paused', line: 'Waits for Fix login redirect', action: null });
  });

  it('shows a notice as a problem’s line', () => {
    const agent = working({ state: 'failed', notice: 'Its process crashed (exit code 1).' });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'problem', line: 'Its process crashed (exit code 1).', action: null });
  });

  it('offers Try again, bordered, on a start that failed, with the harness’s last words as the line', () => {
    const agent = working({ state: 'failed', endedAt: AT, exitCode: 1, startup: { output: 'ANTHROPIC_API_KEY not set', failed: true } });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'problem', line: 'ANTHROPIC_API_KEY not set', action: { kind: 'retry', label: 'Try again', prominent: false } });
  });

  it('says what a starting agent is doing', () => {
    const agent = working({ state: 'starting', startup: { output: '', failed: false } });
    expect(calmFace(agent, 'explicit')).toEqual({ status: 'working', line: 'Starting Claude…', action: null });
  });

  it('says when a scheduled agent runs next is the clock’s job, not the line', () => {
    expect(calmFace(galleryAgent('scheduled'), 'explicit')).toEqual({ status: 'scheduled', line: null, action: null });
  });

  it('fills a button only while the agent needs you', () => {
    for (const state of ['running', 'thinking', 'idle', 'done', 'rate-limited', 'hibernated', 'scheduled', 'failed', 'on-command'] as const) {
      const face = calmFace({ ...galleryAgent(state), pullRequests: [] }, 'explicit');
      if (face.status !== 'needs-you') expect(face.action?.prominent ?? false, state).toBe(false);
    }
  });
});

describe('technicalLine', () => {
  it('names its AI and model, branch, pull requests, raw state and exit code, in that order', () => {
    const agent = working({
      model: 'opus',
      branch: 'docs/onboarding',
      state: 'done',
      endedAt: AT,
      exitCode: 0,
      pullRequests: [{ number: 43, title: 'Docs', url: '', state: 'open', checks: 'passing' }],
    });
    expect(technicalLine(agent)).toBe('Claude · Opus · ⑂ docs/onboarding · PR #43 ✓ · done · exit 0');
  });

  it('says the default model, and a failing or pending check', () => {
    const agent = working({
      harness: 'codex',
      branch: 'fix-it',
      pullRequests: [
        { number: 7, title: 'a', url: '', state: 'open', checks: 'failing' },
        { number: 8, title: 'b', url: '', state: 'draft', checks: 'pending' },
      ],
    });
    expect(technicalLine(agent)).toBe('Codex · default model · ⑂ fix-it · PR #7 ✗ · PR #8 … · running');
  });

  it('says when it shares a folder rather than having a worktree of its own', () => {
    expect(technicalLine(working({ plainFolder: true, branch: '' }))).toBe('Claude · default model · shared folder, no worktree · running');
  });
});
