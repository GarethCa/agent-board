import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { GLANCE_LEVELS, GLANCE_STATES, glanceFace, glanceLine } from './glance-tile';
import { galleryAgent } from './TileGallery';

const AT = '2026-10-22T12:00:00.000Z';

const working = (more: Partial<Agent> = {}): Agent => ({ ...galleryAgent('running'), subagents: [], pullRequests: [], lastMessage: null, ...more });
const pr = (state: 'open' | 'merged') => ({ number: 41, title: 'Add the dock', url: '', state, checks: 'passing' as const });
const permission = {
  id: 'p',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf dist' },
  subagent: null,
  requestedAt: AT,
  heldUntil: null,
  asksInTerminal: false,
  sessionGrant: null,
  dialog: null,
  plan: null,
  questions: null,
};

describe('glanceFace', () => {
  it('tells working from thinking, both at work and quiet in colour', () => {
    expect(glanceFace(working(), 'explicit')).toMatchObject({ state: 'working', level: 1, word: 'Working', action: null });
    expect(glanceFace(working({ state: 'thinking' }), 'explicit')).toMatchObject({ state: 'thinking', level: 1, word: 'Thinking' });
  });

  it('reads a permission prompt as Permission, with one filled Review', () => {
    const face = glanceFace(working({ state: 'needs-permission', permissions: [permission] }), 'explicit');
    expect(face).toEqual({ status: 'needs-you', state: 'permission', level: 2, word: 'Permission', line: 'Bash: rm -rf dist', action: { kind: 'open', label: 'Review', prominent: true } });
  });

  it('reads a question as Needs you, with a filled Answer', () => {
    const agent = working({ state: 'waiting', lastMessage: 'Postgres or SQLite?' });
    expect(glanceFace(agent, 'explicit')).toMatchObject({ state: 'needs', level: 2, word: 'Needs you', action: { label: 'Answer', prominent: true } });
  });

  it('offers open changes as Open PR', () => {
    const face = glanceFace(working({ state: 'idle', pullRequests: [pr('open')] }), 'explicit');
    expect(face).toMatchObject({ state: 'needs', action: { kind: 'pull-request', label: 'Open PR', prominent: true } });
  });

  it('reads a failed agent as Failed, the loudest, with a filled Open', () => {
    const face = glanceFace(working({ state: 'failed', notice: 'Its process crashed (exit code 1).' }), 'explicit');
    expect(face).toEqual({ status: 'problem', state: 'failed', level: 3, word: 'Failed', line: 'Its process crashed (exit code 1).', action: { kind: 'open', label: 'Open', prominent: true } });
  });

  it('keeps a failed start’s Try again', () => {
    const agent = working({ state: 'failed', endedAt: AT, exitCode: 1, startup: { output: 'ANTHROPIC_API_KEY not set', failed: true } });
    expect(glanceFace(agent, 'explicit').action).toEqual({ kind: 'retry', label: 'Try again', prominent: false });
  });

  it('tells idle at its prompt from done and ended', () => {
    expect(glanceFace(working({ state: 'idle' }), 'explicit')).toMatchObject({ state: 'idle', level: 0, word: 'Idle' });
    expect(glanceFace(working({ state: 'done', endedAt: AT }), 'explicit')).toMatchObject({ state: 'done', level: 0, word: 'Done' });
  });

  it('reads paused, usage limit and a reviewer waiting apart', () => {
    const paused = working({ state: 'hibernated', endedAt: AT, hibernated: { at: AT, by: 'you', byId: null } });
    expect(glanceFace(paused, 'explicit')).toMatchObject({ state: 'paused', word: 'Paused', action: { label: 'Wake', prominent: false } });
    expect(glanceFace(working({ state: 'rate-limited' }), 'explicit')).toMatchObject({ state: 'limit', word: 'Usage limit' });
    const reviewer = working({ state: 'idle', reviewOf: 'impl' });
    expect(glanceFace(reviewer, 'explicit', { name: 'Fix login', state: 'running', endedAt: null })).toMatchObject({ state: 'review', word: 'In review', line: 'Waits for Fix login', action: null });
  });

  it('never says its word twice: a line that only repeats it gives way to its status line, else its last message, else nothing', () => {
    const status = { summary: 'Halfway through the tokenizer', progress: null, updatedAt: AT, setBy: null };
    expect(glanceFace(working({ state: 'rate-limited', status }), 'explicit').line).toBe('Halfway through the tokenizer');
    expect(glanceFace(working({ state: 'rate-limited', status: null, lastMessage: 'Paused at the parser.' }), 'explicit').line).toBe('Paused at the parser.');
    expect(glanceFace(working({ state: 'rate-limited', status: null }), 'explicit').line).toBeNull();
  });

  it('passes over a status line with nothing in it, progress or not, for its last message', () => {
    for (const progress of [null, 40]) {
      const agent = working({ state: 'rate-limited', status: { summary: '  ', progress, updatedAt: AT, setBy: null }, lastMessage: 'Paused at the parser.' });
      expect(glanceFace(agent, 'explicit').line, `progress ${progress}`).toBe('Paused at the parser.');
    }
  });

  it('offers a reviewed agent’s open PR quietly while it waits', () => {
    const reviewer = working({ state: 'idle', reviewOf: 'impl', pullRequests: [pr('open')] });
    // Open changes at its prompt want the user first.
    expect(glanceFace(reviewer, 'explicit', { name: 'Fix login', state: 'running', endedAt: null }).state).toBe('needs');
  });

  it('falls back to the first line of its last message when it has nothing else to say', () => {
    expect(glanceFace(working({ lastMessage: '\nMerged as #721.\nAll green.' }), 'explicit').line).toBe('Merged as #721.');
    expect(glanceFace(working(), 'explicit').line).toBeNull();
  });

  it('gives every state a level, and colour only to the ones that want the user', () => {
    const loud = GLANCE_STATES.filter((state) => GLANCE_LEVELS[state] >= 2);
    expect(loud).toEqual(['needs', 'permission', 'failed']);
  });
});

describe("a glance tile's line", () => {
  it('shows a command it asks to run as the command, in mono', () => {
    expect(glanceLine('Bash: launchctl bootout gui/501/x', 'permission')).toEqual({ text: 'launchctl bootout gui/501/x', command: true });
  });

  it('keeps any other line as it is', () => {
    expect(glanceLine('Edit: src/app.ts', 'permission')).toEqual({ text: 'Edit: src/app.ts', command: false });
    expect(glanceLine('Bash: in a sentence', 'working')).toEqual({ text: 'Bash: in a sentence', command: false });
    expect(glanceLine(null, 'idle')).toBeNull();
  });
});
