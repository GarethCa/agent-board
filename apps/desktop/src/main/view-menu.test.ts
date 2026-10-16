import { describe, expect, it } from 'vitest';
import { viewMenu } from './view-menu';

const roles = (packaged: boolean) => (viewMenu(packaged).submenu as { role?: string }[]).map((item) => item.role);

describe('the View menu', () => {
  it('has Reload and Force Reload in a dev build', () => {
    expect(roles(false)).toEqual(expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools']));
  });

  it('has neither in a packaged build, so ⌘R never reloads the app', () => {
    expect(roles(true)).not.toContain('reload');
    expect(roles(true)).not.toContain('forceReload');
    expect(roles(true)).toContain('toggleDevTools');
  });
});
