---
status: accepted
---
# Launch settings' values live outside the database

An agent's launch settings are env vars and Claude settings of its own, and their values may be secrets (an API token, say). They were kept as JSON in the agents table, so they sat in plain text in `board.db`, its write-ahead log and each backup taken before a migration, which anything that can read the data dir can copy. A tracker credential has always been kept in the OS keychain instead.

## Decision

- **The values go in the OS keychain, one item per agent** (`launch-settings.<session id>`, under the board's keychain service), the way a tracker credential does. The agents table keeps only the names (`{"env":[…],"settings":[…]}`), which are all the board shows anyway. A backup taken before a migration keeps only the names, and the backups an older build took are scrubbed as the daemon starts.
- **Where there is no keychain, a file per agent only the user can read** (mode 0600, in `<data dir>/launch-settings-values/`, mode 0700), as a headless host keeps the server's TLS key (ADR 0021). That is Windows, a test's keychain file off macOS, and a Linux host with no Secret Service or no session bus to reach it by. On such a Linux host a value a desktop session kept in the keychain is still there, so a read that finds no file fails ("Try again") rather than taking the settings for gone. A value in a file moves to the keychain at its next write once there is one.
- **The daemon reads every agent's values as it starts**, before any agent launches, and keeps them in memory: a launch can't wait on the keychain. Each keychain call has five seconds, and the start waits five seconds in all. An agent whose values the keychain hasn't given yet is refused at launch, with "Try again", and they are read again in the background. Only a keychain that answers that it has no item (deleted by hand) drops the agent's names. A keychain that fails or is locked keeps them for the next try.
- **Values an older build left in the database move out as the daemon starts.** They are written to the keychain, the names replace them in the row, and the file and its write-ahead log are overwritten (`secure_delete`, then a truncating checkpoint). Values that can't move stay, and the agent still launches with them. Its tile says so at its next launch, and Restart with… shorter values, or none, takes them out. That covers values too long for one keychain write, and a keychain that refuses the write.
- **At most 2,048 bytes of JSON per agent**, which `security -i` takes in one line.
- **An agent's item is deleted with the agent**, whatever its row last said, and an agent's writes and deletes run one at a time in the order they were asked for.

## Consequences

- Launch settings can't hold more than 2,048 bytes. An older build's longer ones keep working, but stay in the database until they are replaced.
- On macOS the first launch-settings write may show the keychain's access prompt. While it is unanswered the start goes on, and that agent waits.
- A host with no keychain keeps the values in files in the data dir. Anyone who can read the data dir as the user can read them there, but they stay out of the database and its backups.
