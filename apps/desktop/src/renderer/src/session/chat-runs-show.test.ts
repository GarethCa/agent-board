import { describe, expect, it } from 'vitest';
import { chatControlsPlace, chatRunsShowFrom } from './chat-runs-show';

describe("when the chat's Expand all / Collapse all show", () => {
  it('always, unless the setting was saved as on hover', () => {
    expect(chatRunsShowFrom(undefined)).toBe('always');
    expect(chatRunsShowFrom('always')).toBe('always');
    expect(chatRunsShowFrom('nonsense')).toBe('always');
    expect(chatRunsShowFrom('hover')).toBe('hover');
  });

  it('always: under Simplified they sit in the header by the name, out of the controls that wait for hover', () => {
    expect(chatControlsPlace({ tabRow: false, simplified: true, show: 'always' })).toBe('simplified-header');
    expect(chatControlsPlace({ tabRow: false, simplified: false, show: 'always' })).toBe('header');
    expect(chatControlsPlace({ tabRow: true, simplified: true, show: 'always' })).toBe('tab-row');
  });

  it('on hover: under Simplified they join the view switch, which shows on hover', () => {
    expect(chatControlsPlace({ tabRow: false, simplified: true, show: 'hover' })).toBe('view-slot');
    expect(chatControlsPlace({ tabRow: false, simplified: false, show: 'hover' })).toBe('header');
    expect(chatControlsPlace({ tabRow: true, simplified: false, show: 'hover' })).toBe('tab-row');
  });
});
