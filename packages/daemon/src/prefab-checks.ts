// The checks a crew prefab's graph passes as its `.crew.json` file is read: each throws `invalidParams` saying what is
// wrong, in words a person who wrote the file by hand can act on. The checks themselves are `prefab-graph-checks.ts`,
// which the app's prefab board runs too.
import { invalidParams } from './params.ts';
import type { CrewPrefab, PrefabMember } from './protocol.ts';
import type { PrefabGraph } from './prefab-graph.ts';
import { graphProblem } from './prefab-graph-checks.ts';

/** Throws `invalidParams` saying what is wrong with a prefab's graph, as a `.crew.json` file is read. */
export function checkGraph(members: readonly Omit<PrefabMember, 'starts'>[], graph: PrefabGraph, onBoard: CrewPrefab['onBoard']): void {
  const problem = graphProblem(members, graph, onBoard);
  if (problem !== null) throw invalidParams(problem.message);
}
