-- not backward-safe: it drops memory_entries and memory_reads, which an older daemon reads.
-- The board keeps no memories. The daemon writes every memory's text to removed-memories-<date>.md in its data folder
-- just before this runs (removed-memories.ts); this drops the memory cards (their connectors go with them, by their
-- trigger), their history and both tables. A removed zone now turns only a queue it held to No agents.
DELETE FROM board_history WHERE item_id IN (SELECT id FROM board_items WHERE kind = 'memory');
DELETE FROM board_items WHERE kind = 'memory';
DROP TABLE memory_reads;
DROP TABLE memory_entries;
DROP TRIGGER board_items_leave_removed_zone;
CREATE TRIGGER board_items_leave_removed_zone BEFORE DELETE ON zones
BEGIN
  UPDATE board_items
  SET zone_id = NULL, x = x + OLD.x, y = y + OLD.y, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    data = CASE WHEN kind = 'queue' THEN json_set(data, '$.noAgents', json('true')) ELSE data END
  WHERE zone_id = OLD.id;
END;
