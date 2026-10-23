-- Who set the agent's status when it was not the agent itself: the name of the orchestrator that set it for its crew.
-- NULL when the agent set it (or none is set).
ALTER TABLE agents ADD COLUMN status_set_by TEXT;
