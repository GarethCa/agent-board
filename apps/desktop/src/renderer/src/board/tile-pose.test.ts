import { describe, expect, it } from 'vitest';
import { poseOfPill, poseOfStatus } from './tile-pose';

const live = (state: Parameters<typeof poseOfStatus>[1]['state']) => ({ state, endedAt: null });

describe("a Classic tile's pose", () => {
  it('is the state its pill draws, and a schedule times its next run', () => {
    expect(poseOfPill('thinking')).toBe('thinking');
    expect(poseOfPill('hibernated')).toBe('hibernated');
    expect(poseOfPill('scheduled')).toBe('on-command');
  });
});

describe("a calm tile's pose", () => {
  it('asks for the user while it needs them, in the word its state has', () => {
    expect(poseOfStatus('needs-you', live('idle'))).toBe('waiting');
    expect(poseOfStatus('needs-you', live('needs-permission'))).toBe('needs-permission');
    expect(poseOfStatus('needs-you', live('stopped-by-restart'))).toBe('stopped-by-restart');
  });

  it('tells an agent at its prompt from one that ended, under Done', () => {
    expect(poseOfStatus('done', live('idle'))).toBe('idle');
    expect(poseOfStatus('done', { state: 'done', endedAt: '2026-11-05T00:00:00.000Z' })).toBe('done');
  });

  it('tells apart what Paused holds', () => {
    expect(poseOfStatus('paused', live('hibernated'))).toBe('hibernated');
    expect(poseOfStatus('paused', live('rate-limited'))).toBe('rate-limited');
    expect(poseOfStatus('paused', live('idle'))).toBe('waiting-on-review');
  });

  it('keeps working while Working, even at its prompt with an orchestrator', () => {
    expect(poseOfStatus('working', live('thinking'))).toBe('thinking');
    expect(poseOfStatus('working', live('on-command'))).toBe('on-command');
    expect(poseOfStatus('working', live('idle'))).toBe('running');
  });

  it('topples for a Problem and times a schedule', () => {
    expect(poseOfStatus('problem', live('failed'))).toBe('failed');
    expect(poseOfStatus('scheduled', live('scheduled'))).toBe('on-command');
  });
});
