-- An agent's reasoning effort, or null for its harness's own: what it was started with, or last set to, which a
-- restart starts it with. Each harness takes its own levels: the daemon checks them before writing one.
ALTER TABLE agents ADD COLUMN effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
