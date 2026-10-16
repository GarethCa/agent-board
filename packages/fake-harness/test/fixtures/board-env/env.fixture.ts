// Run by board-guard.test.ts in a nested Vitest whose environment is an enclosing board's: a test worker sees none of it.
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const OWN = ['AGENT_BOARD_HARNESS_GUARD_DIR', 'AGENT_BOARD_DATA_DIR'];

it('starts the worker with no AGENT_BOARD_* from the enclosing board but the run knobs', () => {
  const names = Object.keys(process.env).filter((name) => name.startsWith('AGENT_BOARD_') && !OWN.includes(name));
  expect(names).toEqual(['AGENT_BOARD_E2E_WORKERS']);
});

it("gives the worker a throwaway app-data dir, so nothing that falls back to it finds the real app's daemon", () => {
  expect(process.env.AGENT_BOARD_DATA_DIR?.startsWith(tmpdir())).toBe(true);
});
