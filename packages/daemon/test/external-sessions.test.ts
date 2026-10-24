import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createExternalSessionHost,
  readStatusFile,
  sessionPlace,
  zoneForPlace,
  type SessionPlace,
} from '../src/external-sessions.ts';
import { MIGRATIONS, migrate } from '../src/migrate.ts';
import type { DaemonEvent, ExternalSession } from '../src/protocol.ts';
import { git, tempDataDir, tempRepo } from './helpers.ts';

const place = (overrides: Partial<SessionPlace>): SessionPlace => ({
  worktree: '/code/app',
  repoRoot: '/code/app',
  folder: '',
  branch: 'main',
  ...overrides,
});

const ZONES = [
  { id: 'repo', repo_root: '/code/app', folder: '' },
  { id: 'web', repo_root: '/code/app', folder: 'apps/web' },
  { id: 'other', repo_root: '/code/other', folder: '' },
];

describe('zone placement', () => {
  it("puts a session in its repo's zone, or the most specific folder zone its folder is in", () => {
    expect(zoneForPlace(ZONES, place({}))).toBe('repo');
    expect(zoneForPlace(ZONES, place({ folder: 'apps/api' }))).toBe('repo');
    expect(zoneForPlace(ZONES, place({ folder: 'apps/web' }))).toBe('web');
    expect(zoneForPlace(ZONES, place({ folder: 'apps/web/src' }))).toBe('web');
    expect(zoneForPlace(ZONES, place({ folder: 'apps/website' }))).toBe('repo');
  });

  it("puts a session in a linked worktree in its main repo's zone", () => {
    expect(zoneForPlace(ZONES, place({ worktree: '/code/app-worktrees/acme-1', folder: 'apps/web' }))).toBe('web');
  });

  it('leaves a session outside every zone, or outside git, unsorted', () => {
    expect(zoneForPlace(ZONES, place({ worktree: '/code/third', repoRoot: '/code/third' }))).toBeNull();
    expect(zoneForPlace(ZONES, { worktree: null, repoRoot: null, folder: '', branch: null })).toBeNull();
    expect(zoneForPlace([{ id: 'web', repo_root: '/code/app', folder: 'apps/web' }], place({}))).toBeNull();
  });

  it('never puts a session in an unbound zone, even one outside git', () => {
    const unbound = { id: 'ideas', repo_root: null, folder: '' };
    expect(zoneForPlace([unbound], { worktree: null, repoRoot: null, folder: '', branch: null })).toBeNull();
    expect(zoneForPlace([unbound, ...ZONES], place({}))).toBe('repo');
  });
});

describe('where a session is', () => {
  it('finds the working tree, main repo, folder and branch of a folder in a linked worktree', async () => {
    const repo = tempRepo('app');
    const worktree = join(tempDataDir(), 'app-acme-1');
    git(repo, 'worktree', 'add', '--quiet', '-b', 'acme-1-thing', worktree);
    onTestFinished(() => void git(repo, 'worktree', 'remove', '--force', worktree));

    expect(await sessionPlace(join(worktree, 'apps', 'web'))).toEqual({
      worktree,
      repoRoot: repo,
      folder: 'apps/web',
      branch: 'acme-1-thing',
    });
    expect(await sessionPlace(repo)).toMatchObject({ worktree: repo, repoRoot: repo, folder: '' });
  });

  it('is nowhere in particular outside git, or for a folder that is gone', async () => {
    expect(await sessionPlace(tempDataDir())).toEqual({ worktree: null, repoRoot: null, folder: '', branch: null });
    expect(await sessionPlace('/no/such/folder')).toEqual({ worktree: null, repoRoot: null, folder: '', branch: null });
  });
});

describe('worker status files', () => {
  it('reads the status file the worker hooks write', () => {
    const worktree = tempDataDir();
    writeStatus(worktree, {
      version: 1,
      issue: 'ACME-15',
      role: 'implement',
      state: 'done',
      summary: 'All green',
      handover: '.agent-board/handover.md',
      review_doc: null,
      updated_at: '2026-10-09T14:00:00Z',
    });
    expect(readStatusFile(worktree)).toEqual({
      state: 'done',
      summary: 'All green',
      issue: 'ACME-15',
      role: 'implement',
      handover: '.agent-board/handover.md',
      reviewDoc: null,
      updatedAt: '2026-10-09T14:00:00Z',
      sessionId: null,
      harness: null,
    });
  });

  it('is null when missing, not JSON, or without a state', () => {
    const worktree = tempDataDir();
    expect(readStatusFile(worktree)).toBeNull();
    writeStatus(worktree, '{ half');
    expect(readStatusFile(worktree)).toBeNull();
    writeStatus(worktree, { summary: 'no state' });
    expect(readStatusFile(worktree)).toBeNull();
  });
});

function writeStatus(worktree: string, status: unknown): void {
  mkdirSync(join(worktree, '.agent-board'), { recursive: true });
  writeFileSync(join(worktree, '.agent-board', 'status.json'), typeof status === 'string' ? status : JSON.stringify(status));
}

/** An external session host on an in-memory database, with its events recorded. */
function host(options: { agentSessions?: string[]; zones?: { repoRoot: string; folder?: string }[] } = {}) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  for (const [index, zone] of (options.zones ?? []).entries()) {
    db.prepare("INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height) VALUES (?, ?, ?, 'z', '#000', 0, 0, 1, 1)").run(
      `zone-${index}`,
      zone.repoRoot,
      zone.folder ?? '',
    );
  }
  const events: DaemonEvent[] = [];
  const external = createExternalSessionHost({
    db,
    groupsDir: '/groups',
    isAgentSession: (id) => options.agentSessions?.includes(id) ?? false,
    broadcast: (event) => events.push(event),
    log: () => {},
    statusPollMs: 20,
  });
  onTestFinished(() => external.stop());
  const updates = () =>
    events.flatMap((event) => (event.type === 'external.updated' ? [event.session] : [])) as ExternalSession[];
  return { db, external, events, updates };
}

/** The groups the daemon made for sessions in no zone. */
const unsortedGroups = (db: DatabaseSync) =>
  db
    .prepare('SELECT id, name, repo_root, x, y, width, height FROM zones WHERE unsorted = 1 AND repo_root IS NULL ORDER BY rowid')
    .all() as { id: string; name: string; repo_root: null; x: number; y: number; width: number; height: number }[];

const hook = (event: string, fields: Record<string, unknown> = {}) => ({
  hook_event_name: event,
  session_id: 'ses-1',
  transcript_path: '/t/ses-1.jsonl',
  ...fields,
});

describe('external sessions', () => {
  it('appear on their first hook, in the zone their cwd is in, and follow their hooks to done', async () => {
    const repo = tempRepo('app');
    const { external, updates } = host({ zones: [{ repoRoot: repo }] });
    const cwd = join(repo, 'apps', 'web');

    await external.onHook('claude', hook('SessionStart', { cwd }));
    await external.onHook('claude', hook('UserPromptSubmit', { cwd, prompt: 'Fix the login page' }));
    await external.onHook('claude', hook('Notification', { cwd, notification_type: 'idle_prompt' }));
    await external.onHook('claude', hook('UserPromptSubmit', { cwd, prompt: 'thanks' }));
    await external.onHook('claude', hook('SessionEnd', { cwd }));

    expect(updates().map((session) => session.state)).toEqual(['running', 'thinking', 'waiting', 'thinking', 'done']);
    const [session] = external.list();
    expect(session).toMatchObject({
      id: 'claude:ses-1',
      harness: 'claude',
      sessionId: 'ses-1',
      zoneId: 'zone-0',
      name: 'app',
      cwd,
      worktree: repo,
      branch: git(repo, 'branch', '--show-current'),
      description: 'Fix the login page',
      state: 'done',
      status: null,
    });
    expect(session!.endedAt).not.toBeNull();
  });

  it('go to the Unsorted group outside every zone, and move into a zone added later', async () => {
    const repo = tempRepo('app');
    const { db, external } = host();
    await external.onHook('codex', hook('SessionStart', { cwd: repo }));
    const [unsorted] = unsortedGroups(db);
    expect(external.list()[0]).toMatchObject({ id: 'codex:ses-1', harness: 'codex', zoneId: unsorted!.id, position: null });

    db.prepare("INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height) VALUES ('late', ?, '', 'z', '#000', 0, 0, 1, 1)").run(repo);
    expect(external.list()[0]!.zoneId).toBe('late');
  });

  it('keep where their tile was moved, in any zone or loose on the board, out of the Unsorted group too', async () => {
    const repo = tempRepo('app');
    const { db, external, updates } = host({ zones: [{ repoRoot: repo }, { repoRoot: tempRepo('other') }] });
    await external.onHook('claude', hook('SessionStart', { cwd: repo }));
    await external.onHook('claude', { ...hook('SessionStart', { cwd: '/' }), session_id: 'ses-2' });
    const [unsorted] = unsortedGroups(db);
    expect(external.list().map(({ zoneId, position }) => ({ zoneId, position }))).toEqual([
      { zoneId: 'zone-0', position: null },
      { zoneId: unsorted!.id, position: null },
    ]);

    const within = external.move('claude:ses-1', { zoneId: 'zone-0', x: 40, y: 60, z: 2 });
    expect(within).toMatchObject({ zoneId: 'zone-0', position: { x: 40, y: 60, z: 2 } });
    expect(updates().at(-1)!.position).toEqual({ x: 40, y: 60, z: 2 });
    expect(external.move('claude:ses-1', { zoneId: 'zone-1', x: 5, y: 6, z: undefined })).toMatchObject({
      zoneId: 'zone-1',
      position: { x: 5, y: 6, z: 2 },
    });
    expect(external.move('claude:ses-2', { zoneId: null, x: -300, y: 10, z: 1 })).toMatchObject({
      zoneId: null,
      position: { x: -300, y: 10, z: 1 },
    });
    // Its folder still says where a new tile of it would go: its hooks don't move it back.
    await external.onHook('claude', hook('Stop', { cwd: repo }));
    expect(external.list().map(({ zoneId, position }) => ({ zoneId, position }))).toEqual([
      { zoneId: 'zone-1', position: { x: 5, y: 6, z: 2 } },
      { zoneId: null, position: { x: -300, y: 10, z: 1 } },
    ]);

    // Its zone gone, it goes back to where its folder puts it.
    db.prepare("DELETE FROM zones WHERE id = 'zone-1'").run();
    expect(external.list()[0]).toMatchObject({ zoneId: 'zone-0', position: null });
  });

  describe('the Unsorted group', () => {
    it('is an ordinary group zone, made right of every zone and level with the topmost, sized for its first tiles', async () => {
      const { db, external, events } = host({ zones: [{ repoRoot: '/code/app' }] });
      db.prepare('UPDATE zones SET x = 100, y = 50, width = 300, height = 200').run();
      await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
      await external.onHook('claude', { ...hook('SessionStart', { cwd: '/' }), session_id: 'ses-2' });
      await external.onHook('claude', { ...hook('SessionStart', { cwd: '/' }), session_id: 'ses-3' });

      expect(unsortedGroups(db)).toEqual([
        { id: expect.any(String), name: 'Unsorted', repo_root: null, x: 440, y: 50, width: 568, height: 216 },
      ]);
      // Told to clients before any session says it is in it, and made only once.
      const kinds = events.map((event) => event.type);
      expect(kinds.indexOf('zone.updated')).toBeLessThan(kinds.indexOf('external.updated'));
      expect(kinds.filter((kind) => kind === 'zone.updated')).toHaveLength(1);
      expect(new Set(external.list().map((session) => session.zoneId)).size).toBe(1);
    });

    it('is not made while every session has a zone, or a place', async () => {
      const repo = tempRepo('app');
      const { db, external } = host({ zones: [{ repoRoot: repo }] });
      await external.onHook('claude', hook('SessionStart', { cwd: repo }));
      expect(unsortedGroups(db)).toEqual([]);
    });

    it('can be moved, resized, renamed and recoloured, and is still where new unplaced sessions go', async () => {
      const { db, external } = host();
      await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
      const [unsorted] = unsortedGroups(db);
      db.prepare("UPDATE zones SET name = 'Strays', color = '#112233', x = 900, y = 900 WHERE id = ?").run(unsorted!.id);

      await external.onHook('claude', { ...hook('SessionStart', { cwd: '/' }), session_id: 'ses-2' });
      expect(unsortedGroups(db)).toHaveLength(1);
      expect(external.list().map((session) => session.zoneId)).toEqual([unsorted!.id, unsorted!.id]);
    });

    it("keeps the tiles dragged out of it where they were put, and gets a fresh group after it is dissolved", async () => {
      const { db, external } = host();
      await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
      const [unsorted] = unsortedGroups(db);
      external.move('claude:ses-1', { zoneId: null, x: 5, y: 6, z: undefined });
      db.prepare('DELETE FROM zones WHERE id = ?').run(unsorted!.id);
      expect(external.list()[0]).toMatchObject({ zoneId: null, position: { x: 5, y: 6 } });
      expect(unsortedGroups(db)).toEqual([]);

      await external.onHook('claude', { ...hook('SessionStart', { cwd: '/' }), session_id: 'ses-2' });
      const [fresh] = unsortedGroups(db);
      expect(fresh!.id).not.toBe(unsorted!.id);
      expect(external.list().map((session) => session.zoneId)).toEqual([null, fresh!.id]);
    });

    it('gets a fresh group when the old one is bound to a repo, which then holds sessions of its own', async () => {
      const repo = tempRepo('app');
      const { db, external } = host();
      await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
      const [old] = unsortedGroups(db);
      db.prepare('UPDATE zones SET repo_root = ? WHERE id = ?').run(repo, old!.id);
      expect(unsortedGroups(db)).toEqual([]);

      await external.onHook('claude', { ...hook('SessionStart', { cwd: '/' }), session_id: 'ses-2' });
      const [fresh] = unsortedGroups(db);
      expect(fresh!.id).not.toBe(old!.id);
      expect(external.list()[1]!.zoneId).toBe(fresh!.id);
    });

    it('is made at daemon start even for sessions that have ended (the old area showed them), but never by a list', async () => {
      const db = new DatabaseSync(':memory:');
      migrate(db, MIGRATIONS.slice(0, 27));
      db.exec("INSERT INTO external_sessions (id, harness, session_id, cwd, state, ended_at) VALUES ('claude:s1', 'claude', 's1', '/', 'done', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
      migrate(db);
      const external = createExternalSessionHost({ db, groupsDir: '/groups', isAgentSession: () => false, broadcast: () => {}, log: () => {} });
      onTestFinished(() => external.stop());
      expect(unsortedGroups(db)).toHaveLength(1);

      db.prepare('DELETE FROM zones').run();
      external.list();
      external.list();
      expect(unsortedGroups(db)).toEqual([]);
      external.placeUnsorted();
      expect(unsortedGroups(db)).toHaveLength(1);
    });

    it('is put right of the zones as the board draws them, grown to hold their tiles, not as they are stored', async () => {
      const db = new DatabaseSync(':memory:');
      migrate(db, MIGRATIONS.slice(0, 27));
      db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height) VALUES ('a', '/code/app', '', 'app', '#4c6ef5', 0, 50, 300, 200);
        INSERT INTO shells (id, zone_id, name, cwd, layout, x, y) VALUES ('sh', 'a', 'sh', '/', '{}', 500, 40);
        INSERT INTO external_sessions (id, harness, session_id, cwd, state) VALUES ('claude:s1', 'claude', 's1', '/', 'idle');`);
      migrate(db);
      const external = createExternalSessionHost({ db, groupsDir: '/groups', isAgentSession: () => false, broadcast: () => {}, log: () => {} });
      onTestFinished(() => external.stop());
      // The tile at x 500 is 256 wide, and the zone has 20 padding past it: drawn 776 wide, not the 300 stored.
      expect(unsortedGroups(db)[0]).toMatchObject({ x: 776 + 40, y: 50 });
    });

    it("is made for a board's sessions that had no zone before it was a group, when the daemon starts", async () => {
      const db = new DatabaseSync(':memory:');
      migrate(db, MIGRATIONS.slice(0, 27));
      db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height) VALUES ('a', '/code/app', '', 'app', '#4c6ef5', 10, 20, 300, 200);
        INSERT INTO external_sessions (id, harness, session_id, cwd, state) VALUES ('claude:s1', 'claude', 's1', '/', 'idle'), ('claude:s2', 'claude', 's2', '/', 'idle');
        INSERT INTO external_sessions (id, harness, session_id, cwd, state, x, y) VALUES ('claude:s3', 'claude', 's3', '/', 'idle', 1, 2);`);
      migrate(db);
      const events: DaemonEvent[] = [];
      const external = createExternalSessionHost({ db, groupsDir: '/groups', isAgentSession: () => false, broadcast: (event) => events.push(event), log: () => {} });
      onTestFinished(() => external.stop());

      const [unsorted] = unsortedGroups(db);
      expect(unsorted).toMatchObject({ name: 'Unsorted', x: 350, y: 20, width: 568 });
      expect(external.list().map((session) => session.zoneId)).toEqual([unsorted!.id, unsorted!.id, null]);
      expect(events.map((event) => event.type)).toEqual(['zone.updated']);
    });
  });

  it('refuse to move into an unknown zone, or an unknown session', async () => {
    const repo = tempRepo('app');
    const { external } = host({ zones: [{ repoRoot: repo }] });
    await external.onHook('claude', hook('SessionStart', { cwd: repo }));

    expect(() => external.move('claude:ses-1', { zoneId: 'nope', x: 0, y: 0, z: undefined })).toThrow(/no zone/);
    expect(() => external.move('claude:nope', { zoneId: 'zone-0', x: 0, y: 0, z: undefined })).toThrow(/no external session/);
  });

  it("ignore agent-board's own agents, hooks without a session id, and a session's hooks after it ended", async () => {
    const { external, updates } = host({ agentSessions: ['ses-1'] });
    await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
    await external.onHook('claude', { hook_event_name: 'SessionStart', cwd: '/' });
    expect(external.list()).toEqual([]);

    const other = host();
    await other.external.onHook('claude', hook('SessionStart', { cwd: '/' }));
    await other.external.onHook('claude', hook('SessionEnd', { cwd: '/' }));
    await other.external.onHook('claude', hook('Stop', { cwd: '/' }));
    expect(other.external.list()[0]!.state).toBe('done');
    // A session first heard of as it ends never gets a tile.
    await other.external.onHook('claude', { ...hook('SessionEnd', { cwd: '/' }), session_id: 'ses-2' });
    expect(other.external.list()).toHaveLength(1);
    expect(updates()).toEqual([]);
  });

  it('come back to life when an ended session is resumed', async () => {
    const { external } = host();
    await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
    await external.onHook('claude', hook('SessionEnd', { cwd: '/' }));
    await external.onHook('claude', hook('SessionStart', { cwd: '/', source: 'resume' }));
    expect(external.list()[0]).toMatchObject({ state: 'running', endedAt: null });
  });

  it("show their worktree's status file, named by the worker's issue and role, and follow it while live", async () => {
    const repo = tempRepo('app');
    writeStatus(repo, { issue: 'ACME-15', role: 'implement', state: 'running', summary: 'Writing tests' });
    const { external, updates } = host();
    await external.onHook('claude', hook('SessionStart', { cwd: repo }));
    expect(external.list()[0]).toMatchObject({ name: 'ACME-15 implement', status: { state: 'running', summary: 'Writing tests' } });

    writeStatus(repo, { issue: 'ACME-15', role: 'implement', state: 'done', summary: 'Pushed', handover: '.agent-board/handover.md' });
    await expect.poll(() => updates().at(-1)?.status?.state).toBe('done');
    expect(updates().at(-1)!.status).toMatchObject({ summary: 'Pushed', handover: '.agent-board/handover.md' });

    rmSync(join(repo, '.agent-board'), { recursive: true });
    await expect.poll(() => updates().at(-1)?.status).toBeNull();
  });

  it("show a status file that names a session only on that session, not on others in the same worktree", async () => {
    const repo = tempRepo('app');
    writeStatus(repo, { issue: 'ACME-15', role: 'implement', state: 'running', summary: 'Mine', session_id: 'ses-1', harness: 'claude' });
    const { external } = host();
    await external.onHook('claude', hook('SessionStart', { cwd: repo }));
    await external.onHook('claude', { ...hook('SessionStart', { cwd: repo }), session_id: 'ses-2' });
    await external.onHook('codex', hook('SessionStart', { cwd: repo }));

    const byId = new Map(external.list().map((session) => [session.id, session]));
    expect(byId.get('claude:ses-1')).toMatchObject({ name: 'ACME-15 implement', status: { summary: 'Mine' } });
    expect(byId.get('claude:ses-2')).toMatchObject({ name: 'app', status: null });
    // Same session id, other harness: not the worker either.
    expect(byId.get('codex:ses-1')).toMatchObject({ status: null });
  });

  it('carry their subagents', async () => {
    const { external } = host();
    await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
    await external.onHook('claude', hook('SubagentStart', { cwd: '/', agent_id: 'a1', agent_type: 'Explore' }));
    expect(external.list()[0]!.subagents).toMatchObject([{ id: 'a1', type: 'Explore', state: 'running' }]);
  });

  it('stay dismissed while live, keeping up with their hooks unseen, until they start again', async () => {
    const { external, updates } = host();
    await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
    await external.onHook('claude', hook('UserPromptSubmit', { cwd: '/', prompt: 'Refactor the parser' }));
    external.dismiss('claude:ses-1');
    const seen = updates().length;

    await external.onHook('claude', hook('PreToolUse', { cwd: '/' }));
    await external.onHook('claude', hook('Stop', { cwd: '/' }));
    expect(external.list()).toEqual([]);
    expect(updates()).toHaveLength(seen);

    await external.onHook('claude', hook('SessionStart', { cwd: '/', source: 'resume' }));
    expect(external.list()[0]).toMatchObject({ state: 'running', description: 'Refactor the parser' });

    external.dismiss('claude:ses-1');
    await external.onHook('claude', hook('SessionEnd', { cwd: '/' }));
    await external.onHook('claude', hook('SessionStart', { cwd: '/', source: 'resume' }));
    // Ended while dismissed: gone for good, so a resume starts it afresh.
    expect(external.list()[0]).toMatchObject({ state: 'running', description: '' });
  });

  it('can be dismissed', async () => {
    const { external, events } = host();
    await external.onHook('claude', hook('SessionStart', { cwd: '/' }));
    external.dismiss('claude:ses-1');
    expect(external.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'external.removed', id: 'claude:ses-1' });
    expect(() => external.dismiss('claude:ses-1')).toThrow(/no external session/);
  });
});
