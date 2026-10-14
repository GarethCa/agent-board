-- The directory a session started in, and how its process ended (NULL while live, or when a signal ended it or the
-- daemon lost it).
ALTER TABLE sessions ADD COLUMN cwd TEXT;
ALTER TABLE sessions ADD COLUMN exit_code INTEGER;
