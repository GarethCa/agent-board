import { describe, expect, it } from 'vitest';
import { fromStepLink, stepLinkUrl } from './step-link';

describe('stepLinkUrl', () => {
  it('opens an https link', () => {
    expect(stepLinkUrl('https://example.com/decision-1')).toBe('https://example.com/decision-1');
    expect(stepLinkUrl('  https://example.com/a?b=1  ')).toBe('https://example.com/a?b=1');
  });
  it('only says anything else', () => {
    for (const link of ['PR #214', 'http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'example.com/x', '']) expect(stepLinkUrl(link)).toBeNull();
  });
});

describe('fromStepLink', () => {
  it('knows a key from the link button (or inside it), so the card neither ticks nor steps on it', () => {
    const inside = (selector: string) => ({ closest: (asked: string) => (asked === selector ? {} : null) });
    expect(fromStepLink(inside('.steps-link-open'))).toBe(true);
    expect(fromStepLink(inside('.steps-go'))).toBe(false);
    expect(fromStepLink({})).toBe(false);
    expect(fromStepLink(null)).toBe(false);
  });
});
