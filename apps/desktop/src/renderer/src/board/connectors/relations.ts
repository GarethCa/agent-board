// The relations of a class diagram, as a connector's ends and dash: one pick sets all three. The line is drawn the way
// the relation reads, from `from` to `to`: a child to its parent, a client to what it uses, a whole to its parts.
import type { Connector, ConnectorLook } from '@agent-board/daemon/protocol';

export type RelationLook = Pick<ConnectorLook, 'startEnd' | 'endEnd' | 'dashed'>;

export interface Relation {
  id: 'association' | 'directed' | 'inheritance' | 'realisation' | 'dependency' | 'aggregation' | 'composition';
  label: string;
  /** Which way it reads, from `from` to `to`, where that is not plain. */
  reads?: string;
  look: RelationLook;
}

export const RELATIONS: readonly Relation[] = [
  { id: 'association', label: 'Association', look: { startEnd: 'none', endEnd: 'none', dashed: false } },
  { id: 'directed', label: 'Directed', look: { startEnd: 'none', endEnd: 'arrow', dashed: false } },
  { id: 'inheritance', label: 'Inheritance', reads: 'child → parent', look: { startEnd: 'none', endEnd: 'triangle', dashed: false } },
  { id: 'realisation', label: 'Realisation', reads: 'class → interface', look: { startEnd: 'none', endEnd: 'triangle', dashed: true } },
  { id: 'dependency', label: 'Dependency', reads: 'user → used', look: { startEnd: 'none', endEnd: 'arrow', dashed: true } },
  { id: 'aggregation', label: 'Aggregation', reads: 'whole → part', look: { startEnd: 'diamond', endEnd: 'none', dashed: false } },
  { id: 'composition', label: 'Composition', reads: 'whole → part', look: { startEnd: 'filled-diamond', endEnd: 'none', dashed: false } },
];

/** The relation a connector's ends and dash are, as drawn; none for ends of its own. */
export const relationOf = (look: RelationLook): Relation['id'] | undefined =>
  RELATIONS.find((relation) => relation.look.startEnd === look.startEnd && relation.look.endEnd === look.endEnd && relation.look.dashed === look.dashed)?.id;

/**
 * A connector the other way round: its ends join the other's object, so its end shapes are by the other one now, while
 * each end's label stays by its object, and its bends (kept from the middle of its ends) are passed in the other order.
 */
export const swapped = ({ from, to, startLabel, endLabel, points }: Pick<Connector, 'from' | 'to' | 'startLabel' | 'endLabel' | 'points'>) => ({
  from: to,
  to: from,
  startLabel: endLabel,
  endLabel: startLabel,
  points: points.toReversed(),
});
