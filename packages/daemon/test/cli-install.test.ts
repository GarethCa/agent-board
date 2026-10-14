import { readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCli } from '../src/cli-install.ts';
import { tempDataDir } from './helpers.ts';

describe('installing the command-line tool', () => {
  it('links agent-board in the bin folder to the launcher, making the folder', () => {
    const bin = join(tempDataDir(), '.local', 'bin');
    expect(installCli('/Users/me/.agent-board/bin/agent-board', bin)).toBe(join(bin, 'agent-board'));
    expect(readlinkSync(join(bin, 'agent-board'))).toBe('/Users/me/.agent-board/bin/agent-board');
  });

  it('replaces a link already there', () => {
    const bin = tempDataDir();
    symlinkSync('/old/agent-board', join(bin, 'agent-board'));
    installCli('/new/agent-board', bin);
    expect(readlinkSync(join(bin, 'agent-board'))).toBe('/new/agent-board');
  });

  it('never replaces a file that is not a link', () => {
    const bin = tempDataDir();
    writeFileSync(join(bin, 'agent-board'), '#!/bin/sh\n');
    expect(() => installCli('/new/agent-board', bin)).toThrow(/isn't a link; move it away first/);
  });
});
