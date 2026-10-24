-- How far apart a zone's Tidy and an orchestrator's arrange in it put things: compact, normal or roomy. The zones
-- there are keep normal, the gaps they were laid out at, so nothing in them reads as misplaced; a new zone takes the
-- default in the settings (`arrangeSpacing`, roomy until changed).
ALTER TABLE zones ADD COLUMN spacing TEXT NOT NULL DEFAULT 'normal' CHECK (spacing IN ('compact', 'normal', 'roomy'));
