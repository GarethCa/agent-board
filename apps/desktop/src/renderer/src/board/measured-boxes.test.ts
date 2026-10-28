import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { measuredText } from '@agent-board/daemon/protocol';
import { expandedBoxes, forgetNoteFits, measuredBoxes, noteFitContext, noteFitKnown, reportNoteFits, sameReport } from './measured-boxes';

const node = (id: string, x: number, y: number, size: { width: number; height: number }, more: Partial<Node> = {}): Node => ({
  id,
  position: { x, y },
  data: {},
  width: size.width,
  height: size.height,
  ...more,
});
const TILE = { width: 256, height: 136 };
const NOTE = { width: 272, height: 200 };

describe('the boxes a window says it draws', () => {
  it('says nothing of what is drawn where and as big as it is saved', () => {
    const nodes = [node('agent:a', 40, 40, TILE), node('item:n', 300, 40, NOTE), node('zone-1', 0, 0, { width: 1200, height: 600 }, { type: 'zone' })];
    expect(measuredBoxes(nodes, nodes, new Map(), new Map(), 'document')).toEqual([]);
  });

  it('says where a tile or item is drawn when an expanded tile pushed it aside, and where it is saved', () => {
    const nodes = [node('agent:a', 40, 40, TILE), node('item:n', 300, 40, NOTE)];
    const shown = [node('agent:a', 40, 640, TILE), node('item:n', 300, 640, NOTE)];
    expect(measuredBoxes(nodes, shown, new Map(), new Map(), 'document')).toEqual([
      { key: 'agent:a', saved: { x: 40, y: 40, ...TILE }, drawn: { x: 40, y: 640, ...TILE } },
      { key: 'item:n', saved: { x: 300, y: 40, ...NOTE }, drawn: { x: 300, y: 640, ...NOTE } },
    ]);
  });

  it('says how big a text item is drawn when its text takes other than its saved size', () => {
    const nodes = [node('item:t', 10, 20, { width: 120, height: 24 })];
    expect(measuredBoxes(nodes, nodes, new Map([['item:t', { width: 260, height: 48 }]]), new Map(), 'document')).toEqual([
      { key: 'item:t', saved: { x: 10, y: 20, width: 120, height: 24 }, drawn: { x: 10, y: 20, width: 260, height: 48 } },
    ]);
  });

  it("says each agent note's height for its text, measured at its width, in the look and with the question and edits it has now", () => {
    const data = { text: 'all done', asked: 'how far?' };
    const nodes = [node('item:n', 300, 40, NOTE, { data: { item: { data } } }), node('item:m', 600, 40, NOTE), node('item:l', 900, 40, NOTE), node('item:q', 1200, 40, NOTE)];
    const context = noteFitContext('document', data);
    const fits = new Map([
      ['item:n', { width: NOTE.width, height: 150, text: 'all done', context }],
      // Resized since it was measured.
      ['item:m', { width: 200, height: 150, text: 'resized since', context: noteFitContext('document', {}) }],
      // Measured in the other look.
      ['item:l', { width: NOTE.width, height: 150, text: 'drawn as a terminal', context: noteFitContext('terminal', {}) }],
      // Measured before it answered a question.
      ['item:q', { width: NOTE.width, height: 150, text: 'before it was asked', context: noteFitContext('document', { asked: 'and now?' }) }],
    ]);
    expect(measuredBoxes(nodes, nodes, new Map(), fits, 'document')).toEqual([
      { key: 'item:n', saved: { x: 300, y: 40, ...NOTE }, drawn: { x: 300, y: 40, ...NOTE }, fits: { height: 150, text: measuredText('all done') } },
    ]);
  });

  it('says the tiles expanded, where each is saved and how big it is expanded', () => {
    const nodes = [node('agent:a', 40, 40, TILE), node('agent:b', 400, 40, TILE)];
    expect(expandedBoxes(nodes, [{ id: 'agent:a', width: 960, height: 600 }, { id: 'agent:gone', width: 960, height: 600 }])).toEqual([
      { key: 'agent:a', x: 40, y: 40, width: 960, height: 600 },
    ]);
  });

  it('tells a report that changed from one that did not', () => {
    const box = { key: 'item:n', saved: { x: 0, y: 0, ...NOTE }, drawn: { x: 0, y: 0, ...NOTE } };
    const report = { boxes: [box], expanded: [] };
    expect(sameReport(report, { boxes: [{ ...box }], expanded: [] })).toBe(true);
    expect(sameReport(report, { boxes: [{ ...box, drawn: { ...box.drawn, y: 8 } }], expanded: [] })).toBe(false);
    expect(sameReport(report, { boxes: [box], expanded: [{ key: 'agent:a', x: 0, y: 0, width: 960, height: 600 }] })).toBe(false);
    expect(sameReport(report, { ...report, away: true })).toBe(false);
  });
});

describe('the heights agent notes measured for their text', () => {
  const context = noteFitContext('document', {});
  const fit = { width: 272, height: 180, text: 'all done', context };

  it('knows a note measured as it is now, and not once its text, width or what is drawn round it changes', () => {
    reportNoteFits(new Map([['item:n', fit]]));
    expect(noteFitKnown('item:n', fit)).toBe(true);
    expect(noteFitKnown('item:n', { ...fit, width: 272.2 })).toBe(true);
    expect(noteFitKnown('item:n', { ...fit, text: 'more to do' })).toBe(false);
    expect(noteFitKnown('item:n', { ...fit, width: 300 })).toBe(false);
    expect(noteFitKnown('item:n', { ...fit, context: noteFitContext('terminal', {}) })).toBe(false);
    expect(noteFitKnown('item:other', fit)).toBe(false);
  });

  it('forgets them all, to measure them again', () => {
    reportNoteFits(new Map([['item:n', fit], ['item:m', { ...fit, text: 'another' }]]));
    forgetNoteFits();
    expect(noteFitKnown('item:n', fit)).toBe(false);
    expect(noteFitKnown('item:m', { ...fit, text: 'another' })).toBe(false);
  });
});
