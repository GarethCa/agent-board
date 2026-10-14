-- Whether Codex agents in the zone start with --dangerously-bypass-hook-trust (ADR-0004): on by default. Off, Codex
-- asks the user to review agent-board's hooks once, in the agent's terminal.
ALTER TABLE zones ADD COLUMN codex_bypass_hook_trust INTEGER NOT NULL DEFAULT 1 CHECK (codex_bypass_hook_trust IN (0, 1));
