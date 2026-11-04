-- Pacing by usage is gone: the user's zone priorities, a zone's budget hold, why an agent was paused for usage, and the
-- switch and thresholds in the settings. The newest usage reading (usage_reading) stays, for display. An agent that was
-- paused for usage stays paused, as any paused agent is, and is woken as one is.
ALTER TABLE zones DROP COLUMN priority;
ALTER TABLE zones DROP COLUMN usage_hold_reason;
ALTER TABLE zones DROP COLUMN usage_hold_at;
ALTER TABLE agents DROP COLUMN hibernated_reason;
DELETE FROM settings WHERE key IN ('usagePacing', 'usageThresholds');
