-- Tabs can move between session windows: tab_order places a tab among its owner's tabs, so one moved
-- in lands after them, and an undone move goes back to where it was. Tabs made before this keep NULL and sort first,
-- by rowid, as they did; each new or moved tab takes the next number. A shell tile on the board leaves it as it is.
ALTER TABLE shells ADD COLUMN tab_order REAL;
