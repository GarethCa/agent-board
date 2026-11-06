// A to-do's `-> link`: what it opens, if it is a web link. Anything else ("PR #214") is only said.

/** The https address `link` opens in the browser, or null when it is not one (the OS browser takes https only). */
export function stepLinkUrl(link: string): string | null {
  try {
    const parsed = new URL(link.trim());
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Whether a key event came from a to-do's link button: its Enter and Space open it, and are not the card's to take. */
export const fromStepLink = (target: { closest?(selector: string): unknown } | null): boolean => target?.closest?.('.steps-link-open') != null;
