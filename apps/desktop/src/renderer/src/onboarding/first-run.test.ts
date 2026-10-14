import { describe, expect, it } from 'vitest';
import type { ToolCheck } from '@agent-board/daemon/protocol';
import { onboardingState, placeCallout, toolRow, readySummary, shouldOpenOnboarding, type RowStatus } from './first-run';

describe('first run', () => {
  it('opens onboarding on an empty board that has never been through it', () => {
    expect(shouldOpenOnboarding(null, true)).toBe(true);
  });

  it('stays closed once it has been finished or skipped, and on a board that already holds something', () => {
    expect(shouldOpenOnboarding({ finished: true, showInMenu: true }, true)).toBe(false);
    // Someone upgrading with a board in use has no need of it.
    expect(shouldOpenOnboarding(null, false)).toBe(false);
  });

  it('reads what was saved, keeping the Getting started row unless it was turned off', () => {
    expect(onboardingState(null)).toEqual({ finished: false, showInMenu: true });
    expect(onboardingState({ finished: true, showInMenu: false })).toEqual({ finished: true, showInMenu: false });
    expect(onboardingState('garbage')).toEqual({ finished: false, showInMenu: true });
  });
});

describe('a CLI row', () => {
  const found = (extra: Partial<Extract<ToolCheck, { found: true }>> = {}): ToolCheck => ({
    tool: 'claude',
    found: true,
    path: '/usr/local/bin/claude',
    ...extra,
  });

  it('is ready once found and signed in, saying its version', () => {
    expect(toolRow(found({ version: '2.1.0', signedIn: true }))).toEqual({ status: 'ready', detail: 'found v2.1.0, signed in' });
  });

  it('needs an action when found but signed out', () => {
    expect(toolRow(found({ version: '2.1.0', signedIn: false }))).toEqual({ status: 'action', detail: 'found v2.1.0, not signed in' });
    expect(toolRow({ ...found({ signedIn: false }), tool: 'gh' })).toEqual({ status: 'action', detail: 'not signed in' });
  });

  it('is ready when found and the CLI could not say whether it is signed in', () => {
    expect(toolRow(found({ version: '2.1.0' }))).toEqual({ status: 'ready', detail: 'found v2.1.0' });
  });

  it('needs an action when the CLI could not be asked, saying why', () => {
    expect(toolRow(found({ version: '2.1.0', problem: 'did not answer in time' }))).toEqual({ status: 'action', detail: 'found v2.1.0, did not answer in time' });
    expect(toolRow(found({ problem: 'could not be run' }))).toEqual({ status: 'action', detail: 'found, could not be run' });
  });

  it('is missing when not on PATH, and checking before it is known', () => {
    expect(toolRow({ tool: 'codex', found: false })).toEqual({ status: 'missing', detail: 'not found' });
    expect(toolRow(undefined)).toEqual({ status: 'checking', detail: 'checking…' });
  });
});

describe('the Connect summary', () => {
  const rows = (...statuses: [RowStatus, boolean][]) => statuses.map(([status, required]) => ({ status, required }));

  it('counts what is ready, and says what is required apart from what is optional', () => {
    expect(readySummary(rows(['missing', true], ['missing', false], ['action', false], ['ready', false]))).toEqual({
      ready: 1,
      total: 4,
      title: '1 of 4 ready',
      detail: '1 required · 2 optional left',
    });
  });

  it('counts nothing required once the required rows are ready', () => {
    expect(readySummary(rows(['ready', true], ['missing', false], ['missing', false]))).toEqual({
      ready: 1,
      total: 3,
      title: '1 of 3 ready',
      detail: '2 optional left',
    });
    expect(readySummary(rows(['ready', true], ['ready', false]))).toEqual({ ready: 2, total: 2, title: 'All set', detail: 'Everything is connected' });
  });
});

describe("a tour callout's place", () => {
  const viewport = { width: 1280, height: 800 };
  const size = { width: 340, height: 180 };

  it('sits below its target, centred on it, with the beak pointing at its middle', () => {
    const target = { x: 600, y: 14, width: 36, height: 36 };
    expect(placeCallout(target, viewport, size)).toEqual({ side: 'below', left: 448, top: 70, beak: 170 });
  });

  it('stays inside the window, the beak still on the target', () => {
    const target = { x: 16, y: 14, width: 200, height: 40 };
    expect(placeCallout(target, viewport, size)).toEqual({ side: 'below', left: 16, top: 74, beak: 100 });
  });

  it('goes above a target too low to fit under', () => {
    const target = { x: 1100, y: 740, width: 120, height: 40 };
    expect(placeCallout(target, viewport, size)).toEqual({ side: 'above', left: 924, top: 540, beak: 236 });
  });

  it('is centred in the window when there is no target', () => {
    expect(placeCallout(undefined, viewport, size)).toEqual({ side: 'centre', left: 470, top: 310, beak: undefined });
  });
});
