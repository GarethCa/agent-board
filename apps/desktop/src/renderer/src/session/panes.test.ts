import { describe, expect, it } from 'vitest';
import { panesLabel } from './panes';

describe('panesLabel', () => {
  it('counts panes, one in the singular', () => {
    expect([panesLabel(1), panesLabel(2), panesLabel(0)]).toEqual(['1 pane', '2 panes', '0 panes']);
  });
});
