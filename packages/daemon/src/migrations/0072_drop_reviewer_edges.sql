-- Starting a reviewer on an agent's branch used to join it to that agent with a manual edge each way, which drew a
-- "Final message" chip with a Send button the user never wanted to press. It joins them to nothing now, so the
-- ones an orchestrator made that way go: manual, plain final-message edges made by an agent, between a reviewer
-- (a detached checkout of a branch) and an agent on that branch in the same repo. An edge the user drew stays.
-- Foreign keys are off while migrations run, so ON DELETE CASCADE does nothing: what happened along each of those
-- edges goes first, by hand, while the edges are still there to match.
CREATE TEMP TABLE reviewer_edges AS
SELECT id
FROM flow_edges
WHERE trigger = 'manual'
  AND payload = 'final-message'
  AND made_by IS NOT NULL
  AND one_off = 0
  AND EXISTS (
    SELECT 1
    FROM agents reviewer
    JOIN agents owner ON owner.repo_root = reviewer.repo_root AND owner.branch = reviewer.reviews_branch
    WHERE reviewer.reviews_branch IS NOT NULL
      AND owner.reviews_branch IS NULL
      AND (
        (flow_edges.from_session_id = reviewer.session_id AND flow_edges.to_session_id = owner.session_id)
        OR (flow_edges.from_session_id = owner.session_id AND flow_edges.to_session_id = reviewer.session_id)
      )
  );
DELETE FROM flow_edge_events WHERE edge_id IN (SELECT id FROM reviewer_edges);
DELETE FROM flow_edges WHERE id IN (SELECT id FROM reviewer_edges);
DROP TABLE reviewer_edges;
