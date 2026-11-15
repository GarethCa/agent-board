import { describe, expect, it } from 'vitest';
import { daemonEntryOverrides, honoursTestOverrides, isPackagedExecutable } from './test-overrides';

describe('test overrides', () => {
  it.each([
    ['/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'darwin', false],
    ['/repo/node_modules/electron/dist/electron', 'linux', false],
    ['C:\\repo\\node_modules\\electron\\dist\\electron.exe', 'win32', false],
    ['/Applications/agent-board.app/Contents/MacOS/agent-board', 'darwin', true],
    ['/opt/agent-board/agent-board', 'linux', true],
    ['C:\\Program Files\\agent-board\\agent-board.exe', 'win32', true],
  ] as const)('%s on %s is packaged: %s', (execPath, platform, packaged) => {
    expect(isPackagedExecutable(execPath, platform)).toBe(packaged);
  });

  it('are honoured in a dev build', () => {
    expect(honoursTestOverrides(false, {})).toBe(true);
  });

  it('are ignored in a packaged build, unless the test flag is set', () => {
    expect(honoursTestOverrides(true, {})).toBe(false);
    expect(honoursTestOverrides(true, { AGENT_BOARD_TEST: '0' })).toBe(false);
    expect(honoursTestOverrides(true, { AGENT_BOARD_TEST: '1' })).toBe(true);
  });

  describe("the daemon's entry", () => {
    const build = JSON.stringify({ version: '0.0.1' });
    const packaged = process.platform === 'win32' ? 'C:\\agent-board\\agent-board.exe' : '/opt/agent-board/agent-board';
    const dev = process.platform === 'win32' ? 'C:\\electron\\electron.exe' : '/repo/node_modules/electron/dist/electron';

    it('takes a fake build in a dev build', () => {
      expect(daemonEntryOverrides(dev, { AGENT_BOARD_FAKE_DAEMON_BUILD: build })).toEqual({ testOverrides: true, fakeBuild: build });
    });

    it('ignores it in a packaged build', () => {
      expect(daemonEntryOverrides(packaged, { AGENT_BOARD_FAKE_DAEMON_BUILD: build })).toEqual({ testOverrides: false, fakeBuild: undefined });
    });

    it('takes it in a packaged build with the test flag', () => {
      expect(daemonEntryOverrides(packaged, { AGENT_BOARD_FAKE_DAEMON_BUILD: build, AGENT_BOARD_TEST: '1' })).toEqual({ testOverrides: true, fakeBuild: build });
    });
  });
});
