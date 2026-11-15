import { existsSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCli } from '../src/cli-install.ts';
import { tempDataDir } from './helpers.ts';

/** A dev or test build, as the tests are: the bin folders are temp ones, so it may link there. */
const DEV = { installedApp: false };

describe('installing the command-line tool', () => {
  it('links agent-board in the bin folder to the launcher, making the folder', () => {
    const bin = join(tempDataDir(), '.local', 'bin');
    expect(installCli('/Users/me/.agent-board/bin/agent-board', bin, DEV)).toBe(join(bin, 'agent-board'));
    expect(readlinkSync(join(bin, 'agent-board'))).toBe('/Users/me/.agent-board/bin/agent-board');
  });

  it('replaces a link already there', () => {
    const bin = tempDataDir();
    symlinkSync('/old/agent-board', join(bin, 'agent-board'));
    installCli('/new/agent-board', bin, DEV);
    expect(readlinkSync(join(bin, 'agent-board'))).toBe('/new/agent-board');
  });

  it('never replaces a file that is not a link', () => {
    const bin = tempDataDir();
    writeFileSync(join(bin, 'agent-board'), '#!/bin/sh\n');
    expect(() => installCli('/new/agent-board', bin, DEV)).toThrow(/isn't a link; move it away first/);
  });

  it("refuses a dev or test build's link in the user's own home, and lets the installed app make it", () => {
    const home = tempDataDir();
    const bin = join(home, '.local', 'bin');
    expect(() => installCli('/dev/agent-board', bin, { installedApp: false, usersHome: home })).toThrow(/only the installed agent-board app changes/);
    expect(existsSync(join(bin, 'agent-board'))).toBe(false);
    installCli('/app/agent-board', bin, { installedApp: true, usersHome: home });
    expect(readlinkSync(join(bin, 'agent-board'))).toBe('/app/agent-board');
  });
});
