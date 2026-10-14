// The trackers agent-board knows, with no Node imports, so the app's renderer can use it too.

/**
 * Every tracker provider, by ID. `auth` is how it logs in: with an API key agent-board keeps in the OS keychain, or
 * with the user's own `gh` login, so agent-board keeps no credential at all. `seenBy` is what its scopes are visible
 * to, and `loginHelp` how to log it in.
 */
export const TRACKER_PROVIDERS = {
  linear: {
    name: 'Linear',
    scopeName: 'team',
    auth: 'apiKey',
    seenBy: 'the API key',
    loginHelp: 'connect it with an API key',
  },
  github: { name: 'GitHub', scopeName: 'repo', auth: 'gh', seenBy: 'gh', loginHelp: 'run `gh auth login`' },
} as const satisfies Record<
  string,
  { name: string; scopeName: string; auth: 'apiKey' | 'gh'; seenBy: string; loginHelp: string }
>;

export type TrackerProvider = keyof typeof TRACKER_PROVIDERS;

export function isTrackerProvider(value: unknown): value is TrackerProvider {
  return typeof value === 'string' && Object.hasOwn(TRACKER_PROVIDERS, value);
}

/** An issue's ID as people write it inside its scope: `ACME-12`, `#34` (for GitHub's `owner/repo#34`). */
export function shortIssueId(issue: { provider: TrackerProvider; id: string }): string {
  return issue.provider === 'github' ? issue.id.slice(issue.id.lastIndexOf('#')) : issue.id;
}
