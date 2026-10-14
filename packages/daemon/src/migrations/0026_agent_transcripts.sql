-- The agent's transcript, which the chat view reads: the `transcript_path` its harness's hooks name, kept from
-- the latest hook of its own (a subagent's hooks may name the subagent's). NULL until its first hook.
ALTER TABLE agents ADD COLUMN transcript_path TEXT;
