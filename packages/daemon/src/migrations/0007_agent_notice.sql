-- What the user should know about how an agent ran, e.g. why agent-board stopped it. NULL when there is nothing.
ALTER TABLE agents ADD COLUMN notice TEXT;
