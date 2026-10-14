// What the app tells the user about logging a tracker in, the same wherever it asks.

/** GitHub needs no token from the user: the app uses gh's own login. Followed by what to do next. */
export function GhLoginHelp() {
  return (
    <>
      agent-board uses the GitHub CLI&apos;s own login and keeps no GitHub token. Run <code>gh auth login</code> in a
      terminal
    </>
  );
}

/** Where a Linear API key comes from, and where it is kept. */
export function apiKeyHint(name: string) {
  return <>Create one in {name} under Settings → Security &amp; access. It is kept in your OS keychain.</>;
}

/** What a Linear personal API key looks like. */
export const LINEAR_KEY_PLACEHOLDER = 'lin_api_…';
