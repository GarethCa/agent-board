import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createFlowEdgeHost } from '../src/flow-edges.ts';
import { MIGRATIONS, migrate } from '../src/migrate.ts';

function host() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  for (const id of ['impl', 'review']) {
    db.prepare('INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES (?, ?, ?, ?)').run(id, 'claude', `token-${id}`, '/w');
    db.prepare(
      'INSERT INTO agents (session_id, name, description, branch, worktree, state, repo_root, codex_bypass_hook_trust) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, id, '', `branch-${id}`, '/w', 'done', '/repo', 0);
  }
  const edges = createFlowEdgeHost({
    db,
    deliver: () => Promise.reject(new Error('not here')),
    finalMessage: () => undefined,
    agent: () => undefined,
    conditions: {} as never,
    heldPayloads: () => 'copy' as never,
    recheckMs: 0,
    broadcast: () => {},
    log: () => {},
  });
  return { db, edges };
}

describe('FlowEdgeHost.link', () => {
  it('makes one manual edge a way, marked as made by the orchestrator, and makes none where one already is', () => {
    const { db, edges } = host();
    const made = edges.link('review', 'impl', 'lead');
    expect(made).toMatchObject({ from: 'review', to: 'impl', trigger: 'manual', payload: 'final-message', madeBy: 'lead' });
    expect(edges.link('review', 'impl', 'lead')).toBeUndefined();

    // An edge the user drew the other way, auto, is kept as it is.
    const mine = edges.create({ from: 'impl', to: 'review', trigger: 'auto' });
    expect(edges.link('impl', 'review', 'lead')).toBeUndefined();
    expect(edges.get(mine.id)).toMatchObject({ trigger: 'auto', madeBy: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_edges').get()).toEqual({ n: 2 });
  });

  it('makes an auto edge when asked', () => {
    const { edges } = host();
    expect(edges.link('review', 'impl', 'lead', 'auto')).toMatchObject({ trigger: 'auto', madeBy: 'lead' });
  });

  it('goes with the agent when the agent is dropped', () => {
    const { db, edges } = host();
    edges.link('review', 'impl');
    edges.link('impl', 'review');
    edges.dropAgent('review');
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_edges').get()).toEqual({ n: 0 });
  });
});

describe('the migration that drops the manual edges starting a reviewer made', () => {
  it('removes an agent-made manual edge between a reviewer and the agent on its branch, and keeps the rest', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const before = MIGRATIONS.filter((each) => each.version < 71);
    migrate(db, before);
    const agent = (id: string, branch: string, reviews: string | null) => {
      db.prepare('INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES (?, ?, ?, ?)').run(id, 'claude', `token-${id}`, '/w');
      db.prepare(
        'INSERT INTO agents (session_id, name, description, branch, worktree, state, repo_root, codex_bypass_hook_trust, reviews_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, id, '', branch, '/w', 'done', '/repo', 0, reviews);
    };
    agent('impl', 'feature', null);
    agent('review', '', 'feature');
    agent('other', 'unrelated', null);
    agent('review2', '', 'feature');
    const edge = (id: string, from: string, to: string, madeBy: string | null, trigger = 'manual') =>
      db.prepare('INSERT INTO flow_edges (id, from_session_id, to_session_id, trigger, payload, made_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, trigger, 'final-message', madeBy);
    edge('back', 'review', 'impl', 'lead');
    edge('next', 'impl', 'review', 'lead');
    edge('mine', 'review', 'other', null);
    edge('theirs', 'other', 'impl', 'lead');
    // Kept: one the user drew between the pair, and an auto one an orchestrator wired by hand.
    db.prepare('INSERT INTO flow_edges (id, from_session_id, to_session_id, trigger, payload, made_by) VALUES (?, ?, ?, ?, ?, ?)').run('drawn', 'review2', 'impl', 'manual', 'final-message', null);
    edge('hand', 'impl', 'review2', 'lead', 'auto');
    migrate(db);
    expect((db.prepare('SELECT id FROM flow_edges ORDER BY id').all() as { id: string }[]).map((row) => row.id)).toEqual(['drawn', 'hand', 'mine', 'theirs']);
  });
});
