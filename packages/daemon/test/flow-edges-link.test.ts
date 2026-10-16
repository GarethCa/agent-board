import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createFlowEdgeHost } from '../src/flow-edges.ts';
import { migrate } from '../src/migrate.ts';

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

  it('goes with the agent when the agent is dropped', () => {
    const { db, edges } = host();
    edges.link('review', 'impl');
    edges.link('impl', 'review');
    edges.dropAgent('review');
    expect(db.prepare('SELECT COUNT(*) AS n FROM flow_edges').get()).toEqual({ n: 0 });
  });
});
