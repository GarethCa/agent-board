-- Named roles: a custom role's name, as the agent was started with it (`designer`), NULL for any other role
-- or a custom one unnamed. A zone's template for the name is a role_templates row keyed by the name.
ALTER TABLE agents ADD COLUMN role_name TEXT;

-- The app's default roles: a custom role's name and template, used in any zone that saved none of its own
-- for the name. One per name, in any case.
CREATE TABLE default_roles (
  name TEXT NOT NULL COLLATE NOCASE PRIMARY KEY,
  body TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
