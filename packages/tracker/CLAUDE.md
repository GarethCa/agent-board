# packages/tracker: code map

Issue trackers (Linear, GitHub) and pull requests, for zones and tiles. `README.md` covers the providers and the fakes.

| What | Files |
|---|---|
| The shared shape | `tracker.ts` (where issues live), `providers.ts` and `pull-request-ref.ts` (no Node imports, so the renderer can use them), `shape.ts` |
| Linear | `linear.ts`, `credentials.ts` |
| GitHub, through the user's `gh` | `github.ts`, `gh.ts`, `pull-requests.ts`, `pull-request-details.ts`, `clone.ts` |
| Fakes for tests (never import them from production code) | `fake.ts`, `fake-gh.ts`, `fake-github.ts` (the fake `bin/gh`), `testing.ts`, `keychain-testing.ts` |
| Recorded HTTP | `http-fixtures.ts`, `fixture-server.ts`; the recordings are in `fixtures/` |

Tests never reach Linear or GitHub: they use the fakes or the recordings.
