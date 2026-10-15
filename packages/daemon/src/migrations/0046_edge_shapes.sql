-- How connectors and flow edges are drawn. A connector's line can bend through points, as a flow edge's can,
-- and a flow edge, like a connector, leaves and arrives at any side of its tiles in any style. The defaults are how each
-- was drawn before: a connector with no bends, and a flow edge from its tile's right side to the other's left, curved.
ALTER TABLE connectors ADD COLUMN points TEXT NOT NULL DEFAULT '[]';
ALTER TABLE flow_edges ADD COLUMN from_side TEXT NOT NULL DEFAULT 'right';
ALTER TABLE flow_edges ADD COLUMN to_side TEXT NOT NULL DEFAULT 'left';
ALTER TABLE flow_edges ADD COLUMN style TEXT NOT NULL DEFAULT 'curved';
ALTER TABLE flow_edges ADD COLUMN points TEXT NOT NULL DEFAULT '[]';
