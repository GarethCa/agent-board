-- Automatic sides for flow edges. An edge's end is on a side the user picked, or on `auto`, picked by the
-- board from where its two tiles are each time it is drawn. An agent never gives an edge its sides (an orchestrator's
-- edge or a named hand-off's one-off), so one an agent made still drawn as edges were before shapes, from the right
-- side to the left, unbent, was never given them: it gets automatic ones. One the user drew may have been dropped on
-- those very handles, and nothing tells the two apart, so it is left as it is.
UPDATE flow_edges SET from_side = 'auto', to_side = 'auto'
  WHERE made_by IS NOT NULL AND from_side = 'right' AND to_side = 'left' AND points = '[]';
