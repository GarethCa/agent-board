import { describe, expect, it } from 'vitest';
import type { Agent, AgentState, PermissionPrompt } from '@agent-board/daemon/protocol';
import { heldPrompts, needsYou, secondsLeft, toolSummary, unseenCount } from './needs-you';

const agent = (sessionId: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({
  sessionId,
  zoneId: 'z1',
  repoRoot: '/code/app',
  position: null,
  harness: 'claude',
  model: null,
  role: null,
  name: sessionId,
  description: '',
  branch: sessionId,
  worktree: `/tmp/${sessionId}`,
  cwd: `/tmp/${sessionId}`,
  state,
  createdAt: '2026-10-09T10:00:00.000Z',
  endedAt: null,
  exitCode: null,
  shellSessionId: null,
  issue: null,
  notice: null,
  muted: false,
  seen: false,
  subagents: [],
  pullRequests: [],
  lastMessage: null,
  permissions: [],
  schedule: null,
  reviewOf: null,
  reviewCap: 3,
  ownsWorktree: true,
  orchestrate: null,
  spawnedBy: null,
  status: null,
  ...fields,
});

const prompt: PermissionPrompt = {
  id: 'p1',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf dist' },
  subagent: null,
  requestedAt: '2026-10-09T10:00:00.000Z',
  heldUntil: '2026-10-09T10:00:20.000Z',
};
const lapsed: PermissionPrompt = { ...prompt, id: 'p2', heldUntil: null };

describe('the unseen count', () => {
  it('leaves out an ask whose session was opened, but keeps it in the inbox', () => {
    const agents = [agent('a', 'waiting'), agent('b', 'waiting', { seen: true }), agent('c', 'needs-permission', { permissions: [prompt], seen: true })];
    expect(unseenCount(agents)).toBe(1);
    expect(needsYou(agents)).toHaveLength(3);
  });
});

describe('the needs-you inbox', () => {
  it('lists the agents waiting for input or needing permission, in board order', () => {
    const agents = [
      agent('a', 'running'),
      agent('b', 'waiting'),
      agent('c', 'idle'),
      agent('d', 'needs-permission'),
      agent('e', 'done'),
    ];
    expect(needsYou(agents).map((a) => a.sessionId)).toEqual(['b', 'd']);
  });

  it('lists an agent with any prompt pending, held or asking in its terminal, whatever its state says', () => {
    expect(needsYou([agent('a', 'running', { permissions: [prompt] })])).toHaveLength(1);
    expect(needsYou([agent('a', 'running', { permissions: [lapsed] })])).toHaveLength(1);
  });

  it('lists a scheduled run that needs you, but not a scheduled agent waiting for its next run', () => {
    const schedule = { cron: '@daily', prompt: 'Sweep', enabled: true, nextRunAt: '2026-10-10T00:00:00.000Z', lastRun: null };
    const agents = [
      agent('between-runs', 'scheduled', { schedule }),
      agent('asking', 'needs-permission', { schedule, permissions: [prompt] }),
      agent('waiting', 'waiting', { schedule }),
    ];
    expect(needsYou(agents).map((a) => a.sessionId)).toEqual(['asking', 'waiting']);
  });

  it('never lists an ended agent', () => {
    expect(needsYou([agent('a', 'waiting', { endedAt: '2026-10-09T10:01:00.000Z' })])).toEqual([]);
  });

  it("picks the prompts still held for the inbox, and counts down each one's hold", () => {
    expect(heldPrompts(agent('a', 'needs-permission', { permissions: [lapsed, prompt] }))).toEqual([prompt]);
    expect(secondsLeft(prompt, Date.parse('2026-10-09T10:00:05.400Z'))).toBe(15);
    expect(secondsLeft(prompt, Date.parse('2026-10-09T10:00:30.000Z'))).toBe(0);
  });
});

describe('tool summaries', () => {
  it("shows a shell call's command, a file tool's path, and anything else as JSON", () => {
    expect(toolSummary({ ...prompt, toolInput: { command: 'rm -rf dist', description: 'Remove build output' } })).toBe(
      'rm -rf dist',
    );
    expect(toolSummary({ ...prompt, toolName: 'Write', toolInput: { file_path: '/tmp/a.ts', content: 'x' } })).toBe('/tmp/a.ts');
    expect(toolSummary({ ...prompt, toolName: 'WebFetch', toolInput: { url: 'https://example.com' } })).toBe(
      '{"url":"https://example.com"}',
    );
    expect(toolSummary({ ...prompt, toolInput: null })).toBe('');
  });

  it('cuts a long summary short', () => {
    const summary = toolSummary({ ...prompt, toolInput: { command: 'x'.repeat(1_000) } });
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary.endsWith('…')).toBe(true);
  });
});
