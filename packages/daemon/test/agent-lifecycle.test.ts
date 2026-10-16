import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAgentLifecycle } from '../src/agent-lifecycle.ts';
import { CODEX_BYPASS_FLAG, type LaunchSpec } from '../src/agent-spawns.ts';
import type { AgentRow, ZoneRow } from '../src/agents.ts';
import { migrate } from '../src/migrate.ts';
import { invalidParams } from '../src/params.ts';
import { AGENT_ERROR, type Agent, type DaemonEvent, type Harness, type SessionInfo } from '../src/protocol.ts';
import { RpcMethodError } from '../src/rpc.ts';
import type { SavedScreen, SessionHost } from '../src/sessions.ts';
import { RESET_MODES } from '../src/shells.ts';
import { removeWorktree, unsavedWork } from '../src/worktrees.ts';
import { tempDataDir } from './helpers.ts';

vi.mock('../src/worktrees.ts', () => ({ unsavedWork: vi.fn(), removeWorktree: vi.fn() }));

beforeEach(() => {
  vi.mocked(unsavedWork).mockReset().mockResolvedValue(undefined);
  vi.mocked(removeWorktree).mockReset().mockResolvedValue(undefined);
});

/** What an agent's row holds, as far as these tests set it. */
interface AgentFields {
  harness?: Harness;
  cwd?: string;
  state?: string;
  ended?: boolean;
  stoppedByRestart?: boolean;
  description?: string;
  notice?: string | null;
  seen?: number;
  harnessSessionId?: string | null;
  transcriptPath?: string | null;
  reviewOf?: string | null;
  reviews?: boolean;
  ownsWorktree?: boolean;
  spawnedBy?: string | null;
  bypass?: number;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * An agent lifecycle over a fresh database, with recording fakes: sessions, launches, and the host it reads. `events`
 * lists what it did in order.
 */
function setup(
  options: { zone?: Partial<ZoneRow>; harnessMissing?: boolean; shimFails?: boolean; busy?: boolean; launch?: (spec: LaunchSpec) => boolean } = {},
) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  onTestFinished(() => db.close());
  const home = tempDataDir();
  const events: string[] = [];
  const launches: LaunchSpec[] = [];
  const broadcasts: DaemonEvent[] = [];
  const logs: string[] = [];
  const shells: { id: string; params: Parameters<SessionHost['createShell']>[0] }[] = [];
  const savedScreens = new Map<string, SavedScreen>();
  /** What each live shell's foreground harness is, now. */
  const shellHarnesses = new Map<string, Harness | null>();
  let killing: Promise<void> = Promise.resolve();
  vi.mocked(removeWorktree).mockImplementation(async (_repoRoot, worktree) => void events.push(`removeWorktree ${worktree}`));
  const selectRow = db.prepare(
    `SELECT a.*, s.harness, s.cwd, s.created_at, s.ended_at, s.exit_code, s.stopped_by_restart
       FROM agents a JOIN sessions s ON s.id = a.session_id WHERE a.session_id = ?`,
  );
  const getRow = (sessionId: string) => selectRow.get(sessionId) as AgentRow | undefined;
  const toAgent = (row: AgentRow): Agent =>
    ({
      sessionId: row.session_id,
      name: row.name,
      harness: row.harness,
      repoRoot: row.repo_root,
      branch: row.branch,
      ownedBranch: row.branch,
      worktree: row.worktree,
      state: row.ended_at !== null && row.stopped_by_restart === 1 ? 'stopped-by-restart' : row.state,
      endedAt: row.ended_at,
      reviewOf: row.review_of,
      reviews: row.reviews_branch === null || row.reviews_head === null ? null : { branch: row.reviews_branch, head: row.reviews_head },
      ownsWorktree: row.owns_worktree === 1,
      shellSessionId: lifecycle.fallbackShell(row.session_id) ?? null,
    }) as Agent;
  const lifecycle = createAgentLifecycle({
    db,
    reviewsDir: join(home, 'reviews'),
    harnessPaths: {
      path: (harness) => (options.harnessMissing ? undefined : `/bin/${harness}`),
      refresh: async (harness) => void events.push(`refresh ${harness}`),
      pending: async () => {},
      launchEnv: (env) => ({ ...env }),
      notFound: (harness) => `${harness} not found`,
    },
    ensureHookShim() {
      if (options.shimFails) throw new Error('read-only');
      events.push('ensureHookShim');
    },
    env: { HOME: home },
    schedules: { remove: (sessionId) => void events.push(`schedules.remove ${sessionId}`) },
    onRemoving: (sessionId) => void events.push(`onRemoving ${sessionId}`),
    endTabs: async (sessionId) => void events.push(`endTabs ${sessionId} deleting=${lifecycle.isDeleting(sessionId)}`),
    isRunningSomething: async (pid) => (events.push(`isRunningSomething ${pid}`), options.busy === true),
    broadcast: (event) => void broadcasts.push(event),
    log: (message) => void logs.push(message),
    sessions: {
      kill(sessionId) {
        events.push(`kill ${sessionId}`);
        return killing.then(() => {
          events.push(`killed ${sessionId}`);
          return { id: sessionId } as SessionInfo;
        });
      },
      forget: (sessionId) => void events.push(`forget ${sessionId}`),
      list: () => shells.map((shell, index) => ({ id: shell.id, pid: 100 + index }) as SessionInfo),
      shellHarnessNow: async (shellId) => shellHarnesses.get(shellId) ?? null,
      savedScreen: (sessionId) => savedScreens.get(sessionId),
      createShell(params) {
        const id = `shell-${shells.length + 1}`;
        shells.push({ id, params });
        events.push(`createShell ${id}`);
        return { id } as SessionInfo;
      },
      shellState: (shellId) => ({ busy: false, ports: [], harness: shellHarnesses.get(shellId) ?? null, lastStatus: undefined }),
    },
    getRow,
    get: (sessionId) => {
      const row = getRow(sessionId);
      return row && toAgent(row);
    },
    requireAgent(sessionId) {
      const row = getRow(sessionId);
      if (row === undefined) throw invalidParams(`no agent ${sessionId}`);
      return toAgent(row);
    },
    repoZone: () => (options.zone === undefined ? undefined : (options.zone as ZoneRow)),
    announce: (sessionId) => void events.push(`announce ${sessionId}`),
    setState: (sessionId, state) => db.prepare('UPDATE agents SET state = ? WHERE session_id = ?').run(state, sessionId),
    unsee: (sessionId) => db.prepare('UPDATE agents SET seen = 0 WHERE session_id = ?').run(sessionId),
    launch(spec) {
      launches.push(spec);
      events.push(`launch ${spec.id}`);
      return options.launch?.(spec) ?? false;
    },
    subagents: {
      set: (sessionId, next) => void events.push(`subagents.set ${sessionId} ${next.length}`),
      delete: (sessionId) => void events.push(`subagents.delete ${sessionId}`),
    },
    permissions: { drop: (sessionId) => void events.push(`permissions.drop ${sessionId}`) },
    transcripts: { forget: (sessionId) => void events.push(`transcripts.forget ${sessionId}`) },
    hookStates: {
      relaunched: (sessionId) => void events.push(`hookStates.relaunched ${sessionId}`),
      deleted: (sessionId) => void events.push(`hookStates.deleted ${sessionId}`),
    },
    deliveries: { forget: (sessionId) => void events.push(`deliveries.forget ${sessionId}`) },
  });

  let tokens = 0;
  /** Adds an agent `id`, ended unless `ended: false`, in a worktree folder of its own unless `cwd` says otherwise. */
  const addAgent = (id: string, fields: AgentFields = {}): AgentRow => {
    const cwd = fields.cwd ?? tempDataDir();
    db.prepare('INSERT INTO sessions (id, harness, hook_token_sha256, cwd, ended_at, stopped_by_restart) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      fields.harness ?? 'claude',
      `token-${++tokens}`,
      cwd,
      fields.ended === false ? null : '2026-10-15T10:00:00Z',
      fields.stoppedByRestart ? 1 : 0,
    );
    db.prepare(
      `INSERT INTO agents (session_id, name, description, branch, worktree, state, repo_root, codex_bypass_hook_trust,
         notice, seen, harness_session_id, transcript_path, review_of, reviews_branch, reviews_head, owns_worktree, spawned_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `agent ${id}`,
      fields.description ?? '',
      `branch-${id}`,
      cwd,
      fields.state ?? 'done',
      '/repo',
      fields.bypass ?? 0,
      fields.notice ?? null,
      fields.seen ?? 1,
      fields.harnessSessionId ?? null,
      fields.transcriptPath ?? null,
      fields.reviewOf ?? null,
      fields.reviews ? 'main' : null,
      fields.reviews ? 'abc123' : null,
      fields.ownsWorktree === false ? 0 : 1,
      fields.spawnedBy ?? null,
    );
    return getRow(id)!;
  };

  /** A Claude transcript for agent `id`, so it has a conversation to carry on. */
  const transcript = () => {
    const path = join(home, 'transcript.jsonl');
    writeFileSync(path, '{}\n');
    return path;
  };

  return {
    lifecycle,
    db,
    home,
    events,
    launches,
    broadcasts,
    logs,
    shells,
    savedScreens,
    shellHarnesses,
    getRow,
    addAgent,
    transcript,
    /** Holds every `sessions.kill` until the returned function is called. */
    holdKills() {
      let release!: () => void;
      killing = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

describe('relaunching an ended agent', () => {
  it('carries on a Claude conversation, back at idle and unseen, its notice cleared', () => {
    const { lifecycle, addAgent, transcript, launches, events, getRow, logs } = setup();
    const row = addAgent('a', { transcriptPath: transcript(), notice: 'old notice', state: 'failed', description: 'the task' });
    expect(lifecycle.relaunch(row, undefined, 'to restart it')).toEqual({ started: true });
    expect(launches).toEqual([
      {
        id: 'a',
        harness: 'claude',
        model: null,
        bypassHookTrust: false,
        zoneId: null,
        cwd: row.cwd,
        worktree: row.worktree,
        task: undefined,
        resume: { codexSessionId: null, claudeConversation: true },
        allowProjectCodexConfig: false,
        size: { cols: 120, rows: 40 },
      },
    ]);
    expect(getRow('a')).toMatchObject({ state: 'idle', seen: 0, notice: null });
    expect(events).toEqual(['launch a', 'subagents.set a 0', 'hookStates.relaunched a', 'announce a']);
    expect(logs).toEqual(['relaunched claude agent a to restart it']);
  });

  it('ends the shell its pane dropped into first', async () => {
    const { lifecycle, addAgent, events } = setup();
    const row = addAgent('a');
    lifecycle.exited('a', false);
    await flush();
    events.length = 0;
    lifecycle.relaunch(row, 'run', 'for a run');
    await flush();
    expect(events.slice(0, 2)).toEqual(['kill shell-1', 'launch a']);
    expect(events).toContain('forget shell-1');
    expect(lifecycle.fallbackShell('a')).toBeUndefined();
  });

  it('starts a Claude agent that never had a turn fresh, on its task, and says so', () => {
    const { lifecycle, addAgent, launches, getRow } = setup();
    lifecycle.relaunch(addAgent('a', { description: 'the task' }), undefined, 'to restart it');
    expect(launches[0]).toMatchObject({ task: 'the task', resume: { codexSessionId: null, claudeConversation: false } });
    expect(getRow('a')!.notice).toBe('No earlier conversation: started fresh');
  });

  it('starts one with no task and no conversation on no prompt at all', () => {
    const { lifecycle, addAgent, launches } = setup();
    lifecycle.relaunch(addAgent('a'), undefined, 'to restart it');
    expect(launches[0]!.task).toBeUndefined();
  });

  it('gives a scheduled run its prompt, saying nothing of a conversation, and starts Codex afresh', () => {
    const { lifecycle, addAgent, launches, getRow, events } = setup();
    lifecycle.relaunch(addAgent('a', { description: 'the task', notice: 'old' }), 'the run', 'for a run');
    lifecycle.relaunch(addAgent('b', { harness: 'codex', harnessSessionId: 'conv' }), 'the run', 'for a run');
    lifecycle.relaunch(addAgent('c', { harness: 'codex' }), 'the run', 'for a run');
    expect(launches.map((spec) => [spec.task, spec.resume])).toEqual([
      ['the run', { codexSessionId: null, claudeConversation: false }],
      ['the run', { codexSessionId: null, claudeConversation: true }],
      ['the run', { codexSessionId: null, claudeConversation: true }],
    ]);
    expect(getRow('a')!.notice).toBeNull();
    expect(getRow('b')!.notice).toBeNull();
    expect(events).toContain('ensureHookShim');
  });

  it("carries on a Codex agent's conversation, and one that never named one starts fresh", () => {
    const { lifecycle, addAgent, launches, getRow } = setup();
    lifecycle.relaunch(addAgent('a', { harness: 'codex', harnessSessionId: 'conv' }), undefined, 'to restart it');
    lifecycle.relaunch(addAgent('b', { harness: 'codex', description: 'the task' }), undefined, 'to restart it');
    expect(launches.map((spec) => [spec.task, spec.resume])).toEqual([
      [undefined, { codexSessionId: 'conv', claudeConversation: true }],
      ['the task', { codexSessionId: null, claudeConversation: false }],
    ]);
    expect(getRow('a')!.notice).toBeNull();
    expect(getRow('b')!.notice).toBe('No earlier conversation: started fresh');
  });

  it("takes its repo zone's Codex setting, or with none the one it last started with, and keeps it", () => {
    const zoned = setup({ zone: { codex_bypass_hook_trust: 1 } });
    zoned.lifecycle.relaunch(zoned.addAgent('a', { harness: 'codex', bypass: 0 }), 'run', 'for a run');
    expect(zoned.launches[0]!.bypassHookTrust).toBe(true);
    expect(zoned.getRow('a')!.codex_bypass_hook_trust).toBe(1);
    const loose = setup();
    loose.lifecycle.relaunch(loose.addAgent('a', { harness: 'codex', bypass: 1 }), 'run', 'for a run');
    expect(loose.launches[0]!.bypassHookTrust).toBe(true);
    const off = setup({ zone: { codex_bypass_hook_trust: 0 } });
    off.lifecycle.relaunch(off.addAgent('a', { harness: 'codex', bypass: 1 }), 'run', 'for a run');
    expect(off.launches[0]!.bypassHookTrust).toBe(false);
    expect(off.getRow('a')!.codex_bypass_hook_trust).toBe(0);
  });

  it('refuses, saying why, when its worktree is gone or its harness is', () => {
    const { lifecycle, addAgent, launches } = setup();
    expect(lifecycle.relaunch(addAgent('a', { cwd: '/no/such/worktree' }), undefined, 'to restart it')).toEqual({
      started: false,
      reason: 'its worktree is gone',
    });
    const missing = setup({ harnessMissing: true });
    expect(missing.lifecycle.relaunch(missing.addAgent('a'), undefined, 'to restart it')).toEqual({
      started: false,
      reason: 'claude not found',
    });
    expect(missing.events).toEqual(['refresh claude']);
    expect([...launches, ...missing.launches]).toEqual([]);
  });

  it("refuses a Codex agent whose hook launcher can't be written, or whose worktree has Codex config", () => {
    const shim = setup({ shimFails: true });
    expect(shim.lifecycle.relaunch(shim.addAgent('a', { harness: 'codex' }), 'run', 'for a run')).toEqual({
      started: false,
      reason: "the Codex hook launcher can't be written: read-only",
    });
    const config = setup({
      launch: () => {
        throw new RpcMethodError(AGENT_ERROR.projectCodexConfig, 'config');
      },
    });
    expect(config.lifecycle.relaunch(config.addAgent('a', { harness: 'codex' }), 'run', 'for a run')).toEqual({
      started: false,
      reason: 'its worktree has Codex config of its own, so start it by hand to review its hooks',
    });
    const broken = setup({
      launch: () => {
        throw new Error('spawn failed');
      },
    });
    const row = broken.addAgent('a', { state: 'failed' });
    expect(broken.lifecycle.relaunch(row, 'run', 'for a run')).toEqual({ started: false, reason: 'it could not be relaunched: spawn failed' });
    expect(broken.getRow('a')!.state).toBe('failed');
  });

  it('stops a Codex agent it launched with the bypass flag once project config appears in its worktree', async () => {
    const { lifecycle, addAgent, events, getRow, broadcasts } = setup({ launch: () => true });
    const row = addAgent('a', { harness: 'codex' });
    lifecycle.relaunch(row, 'run', 'for a run');
    mkdirSync(join(row.cwd, '.codex'));
    lifecycle.checkGuard('a');
    expect(events.at(-1)).toBe('kill a');
    expect(getRow('a')!.notice).toContain(`${join(row.cwd, '.codex')} appeared in its worktree while it ran with ${CODEX_BYPASS_FLAG}`);
    expect(broadcasts).toEqual([{ type: 'agent.updated', agent: expect.objectContaining({ sessionId: 'a' }) }]);
  });

  it('watches no worktree once told to stop, nor one launched without the bypass flag', async () => {
    const guarded = setup({ launch: () => true });
    const row = guarded.addAgent('a', { harness: 'codex' });
    guarded.lifecycle.relaunch(row, 'run', 'for a run');
    guarded.lifecycle.stopGuard('a');
    mkdirSync(join(row.cwd, '.codex'));
    guarded.lifecycle.checkGuard('a');
    // Long enough for its folder watch to have fired, had it still been watching.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(guarded.events).not.toContain('kill a');
    const unflagged = setup();
    const other = unflagged.addAgent('a', { harness: 'codex' });
    unflagged.lifecycle.relaunch(other, 'run', 'for a run');
    mkdirSync(join(other.cwd, '.codex'));
    unflagged.lifecycle.checkGuard('a');
    expect(unflagged.events).not.toContain('kill a');
  });
});

describe("a Codex agent that couldn't resume its conversation", () => {
  it('is started afresh in its worktree once it exits before its SessionStart, saying why', async () => {
    const { lifecycle, addAgent, launches, getRow, events } = setup();
    lifecycle.relaunch(addAgent('a', { harness: 'codex', harnessSessionId: 'conv' }), undefined, 'to restart it');
    lifecycle.exited('a', false);
    await flush();
    expect(launches.map((spec) => spec.resume)).toEqual([
      { codexSessionId: 'conv', claudeConversation: true },
      { codexSessionId: null, claudeConversation: true },
    ]);
    expect(getRow('a')!.notice).toBe("Codex couldn't resume its conversation, so it started a new conversation in the same worktree.");
    expect(events).not.toContain('createShell shell-1');
  });

  it('is not once it has started, nor when its daemon went away, nor when the user stopped it', async () => {
    const started = setup();
    started.lifecycle.relaunch(started.addAgent('a', { harness: 'codex', harnessSessionId: 'conv' }), undefined, 'to restart it');
    started.lifecycle.started('a');
    started.lifecycle.exited('a', false);
    await flush();
    expect(started.launches).toHaveLength(1);
    expect(started.shells).toHaveLength(1);

    const restarted = setup();
    restarted.lifecycle.relaunch(restarted.addAgent('a', { harness: 'codex', harnessSessionId: 'conv' }), undefined, 'to restart it');
    restarted.lifecycle.exited('a', true);
    restarted.lifecycle.exited('a', false);
    await flush();
    expect(restarted.launches).toHaveLength(1);

    const stopped = setup();
    stopped.lifecycle.relaunch(stopped.addAgent('a', { harness: 'codex', harnessSessionId: 'conv' }), undefined, 'to restart it');
    stopped.db.prepare('UPDATE sessions SET ended_at = NULL').run();
    const release = stopped.holdKills();
    const stopping = stopped.lifecycle.stop('a');
    expect(stopped.lifecycle.isStopping('a')).toBe(true);
    stopped.db.prepare("UPDATE sessions SET ended_at = '2026-10-15T11:00:00Z'").run();
    stopped.lifecycle.exited('a', false);
    release();
    await stopping;
    await flush();
    expect(stopped.lifecycle.isStopping('a')).toBe(false);
    expect(stopped.launches).toHaveLength(1);
    expect(stopped.shells).toHaveLength(1);
  });
});

describe("an ended agent's fallback shell", () => {
  it('opens in its folder under its saved screen, once its session has exited', async () => {
    const { lifecycle, addAgent, shells, savedScreens, events } = setup();
    const row = addAgent('a');
    savedScreens.set('a', { data: 'last output', cols: 90, rows: 30 });
    lifecycle.exited('a', false);
    expect(shells).toEqual([]);
    await flush();
    expect(events).toEqual(['kill a', 'killed a', 'createShell shell-1', 'announce a']);
    expect(shells[0]!.params).toEqual({ cols: 90, rows: 30, cwd: row.cwd, restore: `last output${RESET_MODES}\r\n`, zoneId: null });
    expect(lifecycle.fallbackShell('a')).toBe('shell-1');
    expect(lifecycle.fallbackOwner('shell-1')).toBe('a');
    expect(lifecycle.fallbackShellCount()).toBe(1);
  });

  it('opens at the relaunch size with nothing above it when no screen was saved', async () => {
    const { lifecycle, addAgent, shells } = setup();
    addAgent('a');
    lifecycle.exited('a', false);
    await flush();
    expect(shells[0]!.params).toMatchObject({ cols: 120, rows: 40, restore: '' });
  });

  it("doesn't open for a live agent, a reviewer, a gone folder, an agent that has one, or once the daemon closes", async () => {
    const { lifecycle, addAgent, shells } = setup();
    addAgent('live', { ended: false });
    addAgent('reviewer', { reviewOf: 'live' });
    addAgent('gone', { cwd: '/no/such/folder' });
    addAgent('twice');
    addAgent('closing');
    lifecycle.exited('live', false);
    lifecycle.exited('reviewer', false);
    lifecycle.exited('gone', false);
    lifecycle.exited('twice', false);
    lifecycle.exited('twice', false);
    await flush();
    expect(shells.map((shell) => shell.params.cwd)).toEqual([expect.any(String)]);
    expect(lifecycle.fallbackOwner('shell-1')).toBe('twice');
    lifecycle.close();
    lifecycle.exited('closing', false);
    await flush();
    expect(shells).toHaveLength(1);
  });

  it("shows its agent's own ended session again once it exits, forgotten after its exit finishes", async () => {
    const { lifecycle, addAgent, events } = setup();
    addAgent('a');
    lifecycle.exited('a', false);
    await flush();
    events.length = 0;
    expect(lifecycle.shellExited('a')).toBe(false);
    expect(lifecycle.shellExited('shell-1')).toBe(true);
    expect(lifecycle.fallbackShell('a')).toBeUndefined();
    expect(lifecycle.fallbackOwner('shell-1')).toBeUndefined();
    expect(events).toEqual(['kill shell-1', 'announce a']);
    await flush();
    expect(events).toEqual(['kill shell-1', 'announce a', 'killed shell-1', 'forget shell-1']);
  });

  it("tells clients of its agent when what runs in it changes, and names its agent's harness while it runs there", async () => {
    const { lifecycle, addAgent, events, shellHarnesses, getRow } = setup();
    addAgent('a');
    lifecycle.exited('a', false);
    await flush();
    events.length = 0;
    lifecycle.onShellChanged('shell-1');
    lifecycle.onShellChanged('another-shell');
    expect(events).toEqual(['announce a']);
    expect(lifecycle.shellHarnessOf(getRow('a')!)).toBeNull();
    shellHarnesses.set('shell-1', 'codex');
    expect(lifecycle.shellHarnessOf(getRow('a')!)).toBeNull();
    shellHarnesses.set('shell-1', 'claude');
    expect(lifecycle.shellHarnessOf(getRow('a')!)).toBe('claude');
  });
});

describe('stopping an agent', () => {
  it('ends its session, and refuses one that has already ended', async () => {
    const { lifecycle, addAgent, events } = setup();
    addAgent('a', { ended: false });
    addAgent('b');
    await expect(lifecycle.stop('a')).resolves.toMatchObject({ sessionId: 'a' });
    expect(events).toEqual(['kill a', 'killed a']);
    await expect(lifecycle.stop('b')).rejects.toThrow('agent b has already ended');
  });
});

describe('resuming an agent', () => {
  /** An ended agent `a` whose pane dropped into a shell. */
  async function withShell(options: Parameters<typeof setup>[0] = {}, fields: AgentFields = {}) {
    const lifecycleSetup = setup(options);
    lifecycleSetup.addAgent('a', { transcriptPath: lifecycleSetup.transcript(), ...fields });
    lifecycleSetup.lifecycle.exited('a', false);
    await flush();
    lifecycleSetup.events.length = 0;
    return lifecycleSetup;
  }

  it('ends the shell its pane dropped into, then relaunches it to carry on', async () => {
    const { lifecycle, events, logs, launches } = await withShell();
    await expect(lifecycle.resume('a', false)).resolves.toMatchObject({ sessionId: 'a', state: 'idle', shellSessionId: null });
    expect(events).toEqual([
      'kill a',
      'killed a',
      'isRunningSomething 100',
      'kill shell-1',
      'killed shell-1',
      'forget shell-1',
      'launch a',
      'subagents.set a 0',
      'hookStates.relaunched a',
      'announce a',
    ]);
    expect(launches[0]!.resume).toEqual({ codexSessionId: null, claudeConversation: true });
    expect(logs.at(-1)).toBe('relaunched claude agent a to restart it');
    expect(lifecycle.fallbackShellCount()).toBe(0);
  });

  it('says it resumes one its daemon stopped', async () => {
    const { lifecycle, logs } = await withShell({}, { stoppedByRestart: true });
    await lifecycle.resume('a', false);
    expect(logs.at(-1)).toBe('relaunched claude agent a to resume it after a restart');
  });

  it('refuses while its shell runs something, unless forced', async () => {
    const busy = await withShell({ busy: true });
    await expect(busy.lifecycle.resume('a', false)).rejects.toMatchObject({ code: AGENT_ERROR.shellBusy });
    expect(busy.launches).toEqual([]);
    busy.events.length = 0;
    await expect(busy.lifecycle.resume('a', true)).resolves.toMatchObject({ state: 'idle' });
    expect(busy.events).not.toContain('isRunningSomething 100');
    expect(busy.launches).toHaveLength(1);
  });

  it('refuses, even forced, while its own harness runs in its shell', async () => {
    const { lifecycle, shellHarnesses, launches } = await withShell();
    shellHarnesses.set('shell-1', 'claude');
    await expect(lifecycle.resume('a', true)).rejects.toThrow("agent a can't be restarted: claude is running in its shell. Exit it first");
    shellHarnesses.set('shell-1', 'codex');
    await expect(lifecycle.resume('a', false)).resolves.toMatchObject({ state: 'idle' });
    expect(launches).toHaveLength(1);
  });

  it('refuses a running agent, a reviewer whose round is over, and one it cannot relaunch', async () => {
    const { lifecycle, addAgent } = setup();
    addAgent('live', { ended: false });
    addAgent('reviewer', { reviewOf: 'live' });
    addAgent('gone', { cwd: '/no/such/worktree' });
    await expect(lifecycle.resume('live', false)).rejects.toThrow('agent live is still running');
    await expect(lifecycle.resume('reviewer', false)).rejects.toThrow('agent reviewer is a reviewer whose round is over');
    await expect(lifecycle.resume('gone', false)).rejects.toThrow("agent gone can't be resumed: its worktree is gone");
  });

  it('resumes a reviewer its daemon stopped mid-round', async () => {
    const { lifecycle, addAgent, launches, logs } = setup();
    addAgent('author');
    addAgent('reviewer', { reviewOf: 'author', stoppedByRestart: true });
    await lifecycle.resume('reviewer', false);
    expect(launches.map((spec) => spec.id)).toEqual(['reviewer']);
    expect(logs).toEqual(['relaunched claude agent reviewer to resume it after a restart']);
  });
});

describe('deleting an agent', () => {
  it('ends its session, then its tabs, keeps its review, removes its worktree, then forgets it everywhere', async () => {
    const { lifecycle, addAgent, db, home, events, broadcasts, getRow, logs, holdKills } = setup();
    const row = addAgent('a', { ended: false, reviews: true });
    db.prepare("INSERT INTO branch_reviews (repo_root, branch, head, session_id) VALUES ('/repo', 'main', 'abc123', 'a')").run();
    mkdirSync(join(row.worktree, '.agent-board'));
    writeFileSync(join(row.worktree, '.agent-board', 'review.md'), 'looks good');
    const kept = join(home, 'reviews', '1-review.md');
    vi.mocked(removeWorktree).mockImplementation(async (_repoRoot, worktree) => void events.push(`removeWorktree ${worktree} review kept=${existsSync(kept)}`));
    const release = holdKills();
    const deleted = lifecycle.delete('a', false);
    await flush();
    // Nothing else goes until its session has finished exiting.
    expect(events).toEqual(['kill a']);
    release();
    await deleted;
    expect(unsavedWork).toHaveBeenCalledWith('/repo', row.worktree, 'branch-a');
    expect(removeWorktree).toHaveBeenCalledWith('/repo', row.worktree, 'branch-a', false);
    expect(events).toEqual([
      'kill a',
      'killed a',
      'endTabs a deleting=true',
      `removeWorktree ${row.worktree} review kept=true`,
      'schedules.remove a',
      'onRemoving a',
      'forget a',
      'subagents.delete a',
      'hookStates.deleted a',
      'deliveries.forget a',
      'permissions.drop a',
      'transcripts.forget a',
    ]);
    expect(getRow('a')).toBeUndefined();
    expect(lifecycle.isDeleting('a')).toBe(false);
    expect(broadcasts).toEqual([{ type: 'agent.removed', sessionId: 'a' }]);
    expect(logs).toEqual([`deleted agent a and its worktree ${row.worktree}`]);
  });

  it('opens no shell for an agent that exits while it is being deleted', async () => {
    const { lifecycle, addAgent, db, shells, holdKills } = setup();
    addAgent('a', { ended: false });
    const release = holdKills();
    const deleted = lifecycle.delete('a', false);
    await flush();
    db.prepare("UPDATE sessions SET ended_at = '2026-10-15T11:00:00Z'").run();
    lifecycle.exited('a', false);
    release();
    await deleted;
    await flush();
    expect(shells).toEqual([]);
  });

  it('stops watching a bypassed Codex agent it deletes', async () => {
    const { lifecycle, addAgent, events } = setup({ launch: () => true });
    const row = addAgent('a', { harness: 'codex' });
    lifecycle.relaunch(row, 'run', 'for a run');
    await lifecycle.delete('a', true);
    events.length = 0;
    mkdirSync(join(row.cwd, '.codex'));
    lifecycle.checkGuard('a');
    expect(events).toEqual([]);
  });

  it('ends the shell an ended agent dropped into, and opens none as it goes', async () => {
    const { lifecycle, addAgent, events, shells } = setup();
    addAgent('a');
    lifecycle.exited('a', false);
    await flush();
    events.length = 0;
    await lifecycle.delete('a', false);
    expect(events.slice(0, 4)).toEqual(['kill shell-1', 'killed shell-1', 'forget shell-1', 'endTabs a deleting=true']);
    expect(lifecycle.fallbackShellCount()).toBe(0);
    expect(shells).toHaveLength(1);
  });

  it('refuses while its worktree has unsaved work, unless forced or keeping it', async () => {
    const { lifecycle, addAgent, getRow } = setup();
    addAgent('a');
    vi.mocked(unsavedWork).mockResolvedValue('it has uncommitted changes');
    await expect(lifecycle.delete('a', false)).rejects.toMatchObject({ code: AGENT_ERROR.unsavedWork, message: 'agent a: it has uncommitted changes' });
    expect(getRow('a')).toBeDefined();
    await lifecycle.delete('a', false, true);
    expect(removeWorktree).not.toHaveBeenCalled();
    addAgent('b');
    await lifecycle.delete('b', true, false, true);
    expect(removeWorktree).toHaveBeenCalledWith('/repo', expect.any(String), 'branch-b', true);
    expect(unsavedWork).toHaveBeenCalledTimes(1);
  });

  it("leaves the folder of an agent adopted in place alone, and doesn't call it its worktree", async () => {
    const { lifecycle, addAgent, logs } = setup();
    addAgent('a', { ownsWorktree: false });
    await lifecycle.delete('a', false);
    expect(unsavedWork).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(logs).toEqual(['deleted agent a']);
  });

  it('is no longer deleting it when removing its worktree fails, and keeps its row', async () => {
    const { lifecycle, addAgent, getRow, broadcasts } = setup();
    addAgent('a');
    vi.mocked(removeWorktree).mockRejectedValue(new Error('locked'));
    await expect(lifecycle.delete('a', false)).rejects.toThrow('locked');
    expect(lifecycle.isDeleting('a')).toBe(false);
    expect(getRow('a')).toBeDefined();
    expect(broadcasts).toEqual([]);
  });

  it('leaves the agents it started in place, started by no one, and tells their clients', async () => {
    const { lifecycle, addAgent, events, getRow } = setup();
    addAgent('parent');
    addAgent('child', { spawnedBy: 'parent' });
    addAgent('other', { spawnedBy: 'someone' });
    await lifecycle.delete('parent', false);
    expect(getRow('child')!.spawned_by).toBeNull();
    expect(getRow('other')!.spawned_by).toBe('someone');
    expect(events).toContain('announce child');
    expect(events).not.toContain('announce other');
  });

  it("keeps a copy of a reviewer's review for the follow-ups of its branch", async () => {
    const { lifecycle, addAgent, db, home } = setup();
    const row = addAgent('a', { reviews: true });
    addAgent('b', { reviews: true });
    db.prepare("INSERT INTO branch_reviews (repo_root, branch, head, session_id) VALUES ('/repo', 'main', 'abc123', 'a'), ('/repo', 'main', 'abc123', 'b')").run();
    mkdirSync(join(row.worktree, '.agent-board'));
    writeFileSync(join(row.worktree, '.agent-board', 'review.md'), 'looks good');
    await lifecycle.delete('a', false);
    await lifecycle.delete('b', false);
    const reviews = db.prepare('SELECT id, session_id, review_path FROM branch_reviews ORDER BY id').all();
    const kept = join(home, 'reviews', '1-review.md');
    expect(reviews).toEqual([
      { id: 1, session_id: null, review_path: kept },
      { id: 2, session_id: null, review_path: null },
    ]);
    expect(readFileSync(kept, 'utf8')).toBe('looks good');
  });

  it('keeps no review of an agent that reviews nothing', async () => {
    const { lifecycle, addAgent, db, home } = setup();
    const row = addAgent('a');
    db.prepare("INSERT INTO branch_reviews (repo_root, branch, head, session_id) VALUES ('/repo', 'main', 'abc123', 'a')").run();
    mkdirSync(join(row.worktree, '.agent-board'));
    writeFileSync(join(row.worktree, '.agent-board', 'review.md'), 'looks good');
    await lifecycle.delete('a', false);
    expect(db.prepare('SELECT session_id FROM branch_reviews').get()).toEqual({ session_id: 'a' });
    expect(existsSync(join(home, 'reviews'))).toBe(false);
  });
});
