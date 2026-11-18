// The graph checks as the app's prefab board runs them: the first problem and what it is about.
import { describe, expect, it } from 'vitest';
import type { PrefabMember } from './protocol.ts';
import type { PrefabGraph } from './prefab-graph.ts';
import { graphProblem, lineKey } from './prefab-graph-checks.ts';

const member = (id: string, role: string | null): Omit<PrefabMember, 'starts'> => ({ id, role, name: null, harness: 'claude', model: null, effort: null, template: null, subagents: [] });
const members = [member('impl', 'implementer'), member('review', 'reviewer')];
const graph = (lines: PrefabGraph['lines']): PrefabGraph => ({
  inputs: [
    { id: 'prompt', kind: 'prompt' },
    { id: 'end', kind: 'end', as: 'ready' },
  ],
  gates: [{ id: 'loop', rule: 'done', cap: 3, atCap: 'ask', timeout: null }],
  lines,
});
const pair = [
  { from: 'prompt', to: 'impl' },
  { from: 'impl', to: 'review', carries: 'handoff' },
  { from: 'review', to: 'loop', carries: 'review' },
  { from: 'loop', to: 'impl', way: 'again' },
  { from: 'loop', to: 'end', way: 'done' },
] satisfies PrefabGraph['lines'];

describe('graphProblem', () => {
  it('passes a graph the library takes', () => {
    expect(graphProblem(members, graph(pair), 'card')).toBeNull();
  });

  it('names the line a problem is about by its ends', () => {
    const lines = [...pair, { from: 'end', to: 'impl' }];
    expect(graphProblem(members, graph(lines), 'card')).toEqual({ message: expect.stringContaining('is an end, which no line leaves'), about: lineKey({ from: 'end', to: 'impl' }) });
  });

  it('names the loop gate, or the member, a problem is about', () => {
    expect(graphProblem(members, graph(pair.filter((line) => line.way !== 'done')), 'card')?.about).toBe('loop');
    expect(graphProblem([...members, member('docs', 'designer')], graph(pair), 'card')).toEqual({ message: expect.stringContaining('reached from no input'), about: 'docs' });
  });

  it('names the done line that leads back into its own loop, so the board marks that line', () => {
    const back = pair.map((line) => (line.way === 'done' ? { from: 'loop', to: 'review', way: 'done' as const } : line));
    expect(graphProblem(members, graph(back), 'card')).toEqual({ message: expect.stringContaining('go round forever'), about: lineKey({ from: 'loop', to: 'review' }) });
  });
});
