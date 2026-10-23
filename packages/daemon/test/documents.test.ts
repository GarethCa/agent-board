import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { documentTitle } from '../src/document-names.ts';
import { createDocumentHost } from '../src/documents.ts';
import { migrate } from '../src/migrate.ts';
import type { Agent, AgentState, DocumentSummary } from '../src/protocol.ts';
import type { RunStart } from '../src/schedules.ts';
import { createFakeClock } from './fake-clock.ts';
import { tempDataDir } from './helpers.ts';

const START = new Date('2026-10-23T09:00:00.000Z');

/** A host over a fresh database, with an agent `s1` working in a temporary worktree, and what it was told. */
function documents(options: { state?: AgentState; tell?: (text: string) => RunStart } = {}) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec('PRAGMA foreign_keys = OFF');
  const worktree = tempDataDir();
  const agent = { sessionId: 's1', name: 'Write the plan', worktree, endedAt: null, state: options.state ?? 'idle' } as unknown as Agent;
  const clock = createFakeClock(START);
  const told: string[] = [];
  const changes: string[] = [];
  const cards: DocumentSummary[] = [];
  const raw = createDocumentHost({
    db,
    clock,
    changed: (sessionId) => changes.push(sessionId),
    agent: (sessionId) => (sessionId === 's1' ? agent : undefined),
    tell: async (_sessionId, text) => {
      told.push(text);
      return options.tell?.(text) ?? { started: true };
    },
    addCard: async (document) => void cards.push(document),
    log: () => {},
  });
  // The agent shows its files from its worktree.
  const host = { ...raw, show: (sessionId: string, spec: { path: string; title?: string }) => raw.show(sessionId, { worktree, ...spec }) };
  const file = (name: string, text: string) => {
    const path = join(worktree, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  /** The agent writes the file again, a moment later than before. */
  const agentWrites = (path: string, text: string) => {
    writeFileSync(path, text);
    const later = new Date(Date.now() + 5_000 + Math.random() * 1000);
    utimesSync(path, later, later);
  };
  /** The agent writes the file again, its modified time left as it was. */
  const agentWritesSameTime = (path: string, text: string) => {
    const { atime, mtime } = statSync(path);
    writeFileSync(path, text);
    utimesSync(path, atime, mtime);
  };
  return { host, agent, told, changes, cards, file, agentWrites, agentWritesSameTime, clock, worktree };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('documents an agent shows the user', () => {
  it('shows a Markdown file as a document named by its first heading, and the same file again as the same document', () => {
    const { host, file, changes } = documents();
    const path = file('docs/release-plan.md', '# Release 1.4 plan\n\n## Scope\n- Flake fix\n');

    const shown = host.show('s1', { path });
    expect(shown).toMatchObject({ sessionId: 's1', path, title: 'Release 1.4 plan', format: 'markdown', version: 1, writtenBy: 'agent', shownAt: START.toISOString() });
    expect(changes).toEqual(['s1']);

    const again = host.show('s1', { path, title: 'The plan' });
    expect(again).toMatchObject({ id: shown.id, title: 'The plan', version: 1 });
    expect(host.list('s1').map((each) => each.id)).toEqual([shown.id]);
    expect(host.read(shown.id)).toMatchObject({ text: '# Release 1.4 plan\n\n## Scope\n- Flake fix\n' });
  });

  it('shows an HTML page as a document named by its title, and refuses any other file, a relative path or a missing one', () => {
    const { host, file, agent } = documents();
    expect(host.show('s1', { path: file('bench.html', '<html><head><title>Cache benchmark</title></head></html>') })).toMatchObject({ title: 'Cache benchmark', format: 'html' });
    expect(() => host.show('s1', { path: file('notes.txt', 'hello') })).toThrow(/only a Markdown \(\.md\) or HTML \(\.html\) file/);
    expect(() => host.show('s1', { path: 'docs/plan.md' })).toThrow(/absolute/);
    expect(() => host.show('s1', { path: join(agent.worktree, 'gone.md') })).toThrow(/can't show .*gone\.md: can't read it/);
  });

  it('is named by its file when it has no heading', () => {
    expect(documentTitle('/w/docs/notes.md', 'markdown', 'Just text.')).toBe('notes.md');
  });

  it('counts the agent rewriting the file as a new version, and a touch with the same text as none', () => {
    const { host, file, agentWrites, changes } = documents();
    const path = file('plan.md', '# Plan\n\nv1');
    const { id } = host.show('s1', { path });
    changes.length = 0;

    agentWrites(path, '# Plan\n\nv1');
    host.poll();
    expect(host.read(id)).toMatchObject({ version: 1 });

    agentWrites(path, '# Better plan\n\nv2');
    host.poll();
    expect(changes).toEqual(['s1']);
    expect(host.read(id)).toMatchObject({ version: 2, title: 'Better plan', writtenBy: 'agent', text: '# Better plan\n\nv2' });
  });

  it('writes the user’s edit to the file and tells the agent what changed, at its prompt', async () => {
    const { host, file, told } = documents();
    const path = file('docs/release-plan.md', '## Order\nMerge the flake fix first, then the pin bump.\n');
    const { id } = host.show('s1', { path });

    const saved = host.save(id, '## Order\nHold the pin bump to 1.5.\n', 1);
    await settle();

    expect(saved).toMatchObject({ version: 2, writtenBy: 'user' });
    expect(readFileSync(path, 'utf8')).toBe('## Order\nHold the pin bump to 1.5.\n');
    expect(told).toEqual([
      [
        "[agent-board] The user edited docs/release-plan.md (v2). The file is already changed; you don't need to apply this:",
        '  ## Order',
        '- Merge the flake fix first, then the pin bump.',
        '+ Hold the pin bump to 1.5.',
      ].join('\n'),
    ]);
  });

  it('keeps what the user changed until the agent is back at its prompt, then tells it all at once', async () => {
    const busy = { started: false, reason: 'it is working', busy: true } as const;
    let ready = false;
    const { host, file, told, agent } = documents({ state: 'running', tell: () => (ready ? { started: true } : busy) });
    const { id } = host.show('s1', { path: file('plan.md', 'one\n') });

    host.save(id, 'two\n', 1);
    host.comment(id, 'Is two right?');
    await settle();
    expect(told).toEqual([]);

    Object.assign(agent, { state: 'idle' });
    ready = true;
    host.observe(agent);
    await settle();
    expect(told).toEqual([
      "[agent-board] The user edited plan.md (v2). The file is already changed; you don't need to apply this:\n- one\n+ two\n\n[agent-board] The user commented on plan.md (v2):\nIs two right?",
    ]);

    host.observe(agent);
    await settle();
    expect(told).toHaveLength(1);
  });

  it('refuses to save over a rewrite the user hasn’t seen, unless they keep theirs', () => {
    const { host, file, agentWrites } = documents();
    const path = file('plan.md', 'v1\n');
    const { id } = host.show('s1', { path });

    agentWrites(path, 'v2 by the agent\n');
    expect(() => host.save(id, 'mine\n', 1)).toThrow(/the agent wrote v2 while you were editing v1/);
    expect(readFileSync(path, 'utf8')).toBe('v2 by the agent\n');

    expect(host.save(id, 'mine\n', 1, true)).toMatchObject({ version: 3, writtenBy: 'user' });
    expect(readFileSync(path, 'utf8')).toBe('mine\n');
  });

  it('leaves an HTML document view-only', () => {
    const { host, file } = documents();
    const { id } = host.show('s1', { path: file('bench.html', '<p>41 ms</p>') });
    expect(() => host.save(id, '<p>40 ms</p>', 1)).toThrow(/view-only/);
  });

  it('forgets an agent’s documents with it', () => {
    const { host, file } = documents();
    const { id } = host.show('s1', { path: file('plan.md', 'x') });
    host.forget('s1');
    expect(host.list('s1')).toEqual([]);
    expect(() => host.read(id)).toThrow(/no document/);
  });
  it('sees a rewrite that kept the file’s modified time, so the user’s save never goes over it unseen', () => {
    const { host, file, agentWritesSameTime } = documents();
    const path = file('plan.md', 'one\n');
    const { id } = host.show('s1', { path });

    agentWritesSameTime(path, 'two\n');
    expect(host.read(id)).toMatchObject({ version: 2, writtenBy: 'agent', text: 'two\n' });

    agentWritesSameTime(path, 'three\n');
    expect(() => host.save(id, 'mine\n', 2)).toThrow(/the agent wrote v3 while you were editing v2/);
    expect(readFileSync(path, 'utf8')).toBe('three\n');
  });

  it('tells the agent its changes were undone when the user keeps theirs over its rewrite', async () => {
    const { host, file, agentWrites, told } = documents();
    const path = file('plan.md', 'one\n');
    const { id } = host.show('s1', { path });
    agentWrites(path, 'one\nagent line\n');

    host.save(id, 'one\nmine\n', 1, true);
    await settle();
    expect(told).toEqual([
      '[agent-board] The user kept their version of plan.md over your v2 (now v3), which undoes your changes since v1. The file is already changed:\n  one\n- agent line\n+ mine',
    ]);
  });

  it('shows a link as the file it leads to, and writes only a file inside the worktree that is still no link', () => {
    const { host, file, worktree } = documents();
    const real = file('docs/real.md', '# Real\n');
    const link = join(worktree, 'notes.md');
    symlinkSync(real, link);
    const shown = host.show('s1', { path: link });
    expect(shown).toMatchObject({ path: real, editable: true });

    // A link out of the worktree is shown, read only, by where it leads.
    const outside = join(tempDataDir(), 'config.md');
    writeFileSync(outside, 'secret: 1\n');
    const away = join(worktree, 'away.md');
    symlinkSync(outside, away);
    const { id } = host.show('s1', { path: away });
    expect(host.read(id)).toMatchObject({ path: outside, editable: false, text: 'secret: 1\n' });
    expect(() => host.save(id, 'secret: 2\n', 1)).toThrow(/outside its agent's worktree/);
    expect(readFileSync(outside, 'utf8')).toBe('secret: 1\n');

    // The file made a link after it was shown isn't written through.
    unlinkSync(real);
    symlinkSync(outside, real);
    expect(() => host.save(shown.id, 'secret: 3\n', 1)).toThrow(/made a link since it was shown/);
    expect(lstatSync(real).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('secret: 1\n');
  });

  it('keeps a file’s Windows line breaks, and tells the agent only the line that changed', async () => {
    const { host, file, told } = documents();
    const path = file('plan.md', 'a\r\nb\r\nc\r\n');
    const { id } = host.show('s1', { path });
    expect(host.read(id).text).toBe('a\nb\nc\n');

    host.save(id, 'a\nB\nc\n', 1);
    await settle();
    expect(readFileSync(path, 'utf8')).toBe('a\r\nB\r\nc\r\n');
    expect(told[0]!.endsWith('\n  a\n- b\n+ B\n  c')).toBe(true);
  });

  it('refuses to save a file deleted since it was shown, never making it again', () => {
    const { host, file } = documents();
    const path = file('plan.md', 'one\n');
    const { id } = host.show('s1', { path });
    unlinkSync(path);
    expect(() => host.save(id, 'two\n', 1)).toThrow(/the file is gone/);
    expect(existsSync(path)).toBe(false);
  });

  it('keeps the file’s mode, and says a refusal after the user’s own save was theirs, not the agent’s', () => {
    const { host, file } = documents();
    const path = file('plan.md', 'one\n');
    const { id } = host.show('s1', { path });
    utimesSync(path, new Date(), new Date());
    const { mode } = statSync(path);
    host.save(id, 'two\n', 1);
    expect(statSync(path).mode).toBe(mode);
    expect(() => host.save(id, 'three\n', 1)).toThrow(/it was saved as v2 since you began editing v1/);
  });
});
