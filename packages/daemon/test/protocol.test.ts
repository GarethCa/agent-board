import { describe, expect, it } from 'vitest';
import { lineSplitter, normalisedAngle, notOrchestratingReason, validZoneFillOpacity, ZONE_COLOR_NAMES, ZONE_COLORS } from '../src/protocol.ts';

function split(chunks: string[], maxLength?: number) {
  const lines: string[] = [];
  const feed = lineSplitter((line) => lines.push(line), maxLength);
  const accepted = chunks.map((chunk) => feed(chunk));
  return { lines, accepted };
}

describe('lineSplitter', () => {
  it('reassembles lines split across chunks and splits several lines in one chunk', () => {
    expect(split(['{"a":', '1}\n{"b"', ':2}\n{"c":3}\n']).lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('holds a trailing partial line until its newline arrives', () => {
    expect(split(['one\ntw']).lines).toEqual(['one']);
    expect(split(['one\ntw', 'o\n']).lines).toEqual(['one', 'two']);
  });

  it('skips blank lines', () => {
    expect(split(['\n\none\n  \n']).lines).toEqual(['one']);
  });

  it('reports an unfinished line that has grown past the limit', () => {
    expect(split(['12345', '678'], 6).accepted).toEqual([true, false]);
    expect(split(['12345\n', '678'], 6).accepted).toEqual([true, true]);
  });
});

describe('zone colours', () => {
  it('each have a name, and no two share one', () => {
    const names = ZONE_COLORS.map((color) => ZONE_COLOR_NAMES[color]);
    expect(names.every((name) => typeof name === 'string' && name !== '')).toBe(true);
    expect(new Set(names).size).toBe(ZONE_COLORS.length);
  });

  it('are 16 distinct #rrggbb colours, with the original eight first so existing zones keep theirs', () => {
    expect(ZONE_COLORS).toHaveLength(16);
    expect(new Set(ZONE_COLORS).size).toBe(16);
    expect(ZONE_COLORS.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    expect(ZONE_COLORS.slice(0, 8)).toEqual(['#4c6ef5', '#12b886', '#f59f00', '#e64980', '#7950f2', '#15aabf', '#fa5252', '#82c91e']);
    expect(ZONE_COLORS.slice(8).map((color) => ZONE_COLOR_NAMES[color])).toEqual([
      'Orange', 'Green', 'Grape', 'Yellow', 'Sky', 'Brown', 'Periwinkle', 'Graphite',
    ]);
  });
});

describe('validZoneFillOpacity', () => {
  it('takes whole percents from 0 to 40 in steps of 2, and nothing else', () => {
    expect([0, 2, 8, 40].every(validZoneFillOpacity)).toBe(true);
    expect([-2, 1, 7, 42, 8.5, Number.NaN, '8', null, undefined].some(validZoneFillOpacity)).toBe(false);
  });
});

describe('normalisedAngle', () => {
  it('keeps an angle in [-180, 180), with no -0', () => {
    expect(normalisedAngle(190)).toBe(-170);
    expect(normalisedAngle(-190)).toBe(170);
    expect(normalisedAngle(180)).toBe(-180);
    expect(normalisedAngle(720)).toBe(0);
    expect(Object.is(normalisedAngle(-360), 0)).toBe(true);
  });
});

describe('notOrchestratingReason', () => {
  const caller = { sessionId: 'impl', name: 'impl' };
  const agent = { sessionId: 'impl', spawnedBy: null, endedAt: null, zoneId: 'z' };
  const zones = (agentsOrchestrate: boolean) => [{ id: 'z', name: 'web', agentsOrchestrate }];

  it("points at the zone's setting when it is off, and says it reaches only agents started after", () => {
    expect(notOrchestratingReason(caller, agent, zones(false))).toBe(
      "impl may not orchestrate: orchestrating is off in web. The user can turn it on (Let agents orchestrate, in the zone's ⋯ menu) for the agents started there after",
    );
  });

  it('says truly why when the zone allows it', () => {
    expect(notOrchestratingReason(caller, agent, zones(true))).toBe(
      "impl may not orchestrate: the user didn't start it in web while orchestrating was on there. The agents the user starts there now may",
    );
    expect(notOrchestratingReason(caller, { ...agent, zoneId: null }, zones(true))).toMatch(/it is in no zone/);
    expect(notOrchestratingReason(caller, { ...agent, spawnedBy: 'lead' }, zones(true))).toMatch(/an agent an orchestrator started never does/);
    expect(notOrchestratingReason(caller, { ...agent, endedAt: '2026-10-13T00:00:00Z' }, zones(true))).toMatch(/it has ended/);
    expect(notOrchestratingReason({ sessionId: 'pane', name: 'impl' }, agent, zones(true))).toMatch(/it has ended/);
    expect(notOrchestratingReason({ sessionId: 'sh', name: 'sh' }, undefined, zones(true))).toMatch(/not a shell/);
  });
});
