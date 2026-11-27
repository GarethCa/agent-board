// Whether a link is a web link. No Node imports, so the daemon, the app's main process and its renderer share one rule.

/**
 * Whether `url` is a web link the app may open or keep: `https://` in any case, then a host, with no whitespace. Never
 * plain http, `file:`, `javascript:` or any other scheme.
 */
export function isWebUrl(url: string): boolean {
  if (!/^https:\/\/\S+$/i.test(url)) return false;
  try {
    return new URL(url).hostname !== '';
  } catch {
    return false;
  }
}
