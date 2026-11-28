import { describe, expect, it } from 'vitest';
import { chromeFor, SAFE_MARGIN, TRAFFIC_LIGHTS, trafficLightsBox, trafficLightsZone, zoneProperties } from './traffic-lights';

describe('the traffic lights’ safe zone', () => {
  it('tells each window from its query, the board when the query names no other', () => {
    expect(chromeFor({})).toBe('board');
    expect(chromeFor({ popOut: 'agent-1' })).toBe('pop-out');
    expect(chromeFor({ settings: '1' })).toBe('settings');
    expect(chromeFor({ overview: '1' })).toBe('overview');
  });

  it('is the lights’ box with a margin round it, from the window’s top-left, in each window', () => {
    for (const kind of ['board', 'pop-out', 'settings', 'overview'] as const) {
      const box = trafficLightsBox(kind);
      expect(box.left).toBe(TRAFFIC_LIGHTS[kind].x);
      expect(box.top).toBe(TRAFFIC_LIGHTS[kind].y);
      expect(trafficLightsZone({ inset: true, fullScreen: false, kind })).toEqual({ right: box.right + SAFE_MARGIN, bottom: box.bottom + SAFE_MARGIN });
    }
    expect(trafficLightsZone({ inset: true, fullScreen: false, kind: 'board' })).toEqual({ right: 78, bottom: 52 });
  });

  it('is nothing where the OS frame holds the window controls, or in full screen, where macOS hides the lights', () => {
    expect(trafficLightsZone({ inset: false, fullScreen: false, kind: 'board' })).toEqual({ right: 0, bottom: 0 });
    expect(trafficLightsZone({ inset: true, fullScreen: true, kind: 'pop-out' })).toEqual({ right: 0, bottom: 0 });
  });

  it('is the page’s two properties, in pixels', () => {
    expect(zoneProperties({ right: 78, bottom: 52 })).toEqual({ '--traffic-lights-right': '78px', '--traffic-lights-bottom': '52px' });
  });
});
