-- What a connector needs to draw a diagram's relations: a dashed line, and a label at each end (a multiplicity such as
-- `0..*`, or a role). Its new end shapes (`triangle`, `diamond`, `filled-diamond`) go in `start_end` and `end_end` as
-- they are.
--
-- Backward-safe: it only adds columns with defaults, which an older daemon never names. To go back to schema 60 by
-- hand, `PRAGMA user_version = 60;` is enough: the columns stay, unread, and an end an older app doesn't know is drawn
-- with none.
ALTER TABLE connectors ADD COLUMN dashed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connectors ADD COLUMN start_label TEXT NOT NULL DEFAULT '';
ALTER TABLE connectors ADD COLUMN end_label TEXT NOT NULL DEFAULT '';
