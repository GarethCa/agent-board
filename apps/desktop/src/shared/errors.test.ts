import { describe, expect, it } from 'vitest';
import { errorMessage, ipcErrorMessage } from './errors';

describe('errorMessage', () => {
  it("is an error's message, without its name", () => {
    expect(errorMessage(new Error('the daemon is not running'))).toBe('the daemon is not running');
  });

  it('is any other value as text', () => {
    expect(errorMessage('timed out')).toBe('timed out');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('ipcErrorMessage', () => {
  it("is the daemon's message, without the wrapping a failed IPC invoke adds", () => {
    const wrapped = new Error("Error invoking remote method 'zones:add': Error: not a git repository");
    expect(ipcErrorMessage(wrapped)).toBe('not a git repository');
    const typed = new Error("Error invoking remote method 'agents:spawn': DaemonRpcError: the zone is still cloning");
    expect(ipcErrorMessage(typed)).toBe('the zone is still cloning');
  });

  it('leaves a message without that wrapping as it is', () => {
    expect(ipcErrorMessage(new Error('timed out'))).toBe('timed out');
  });
});
