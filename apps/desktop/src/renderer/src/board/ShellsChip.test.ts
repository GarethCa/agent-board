import { describe, expect, it } from 'vitest';
import { stateText } from './ShellsChip';

const shell = { tab: 't', sessionId: 's', label: 'dev' };

describe("a shells chip row's state", () => {
  it('says the ports a running shell listens on, a failed last command, and how an ended one exited', () => {
    expect(stateText({ ...shell, state: 'running', ports: [3000, 5173] })).toBe('running · :3000 :5173');
    expect(stateText({ ...shell, state: 'running' })).toBe('running');
    expect(stateText({ ...shell, state: 'failed', failedCommand: 2 })).toBe('last command failed · exit 2');
    expect(stateText({ ...shell, state: 'failed', exitCode: 1 })).toBe('exit 1');
    expect(stateText({ ...shell, state: 'failed', exitCode: null })).toBe('ended by a signal');
    expect(stateText({ ...shell, state: 'idle' })).toBe('idle');
  });
});
