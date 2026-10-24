// The relations of a class diagram live in the protocol, which the board CLI and MCP draw with too; here, what the
// board does with a connector's ends besides.
import type { Connector } from '@agent-board/daemon/protocol';

export { RELATIONS, relationOf, type Relation, type RelationLook } from '@agent-board/daemon/protocol';

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
