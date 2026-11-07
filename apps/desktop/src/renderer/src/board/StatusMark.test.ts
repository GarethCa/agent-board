import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HUMAN_STATUSES } from '@agent-board/daemon/human-status';
import { StatusMark } from './StatusMark';
import { StatusMarkGallery } from './StatusMarkGallery';

const marksIn = (html: string) => [...html.matchAll(/<span class="status-mark"[^>]*data-status="([^"]+)" data-look="([^"]+)">(.*?)<span class="status-mark-word">([^<]+)<\/span><\/span>/g)];

describe('a status mark', () => {
  it('draws a glyph and the word by default', () => {
    const [mark] = marksIn(renderToStaticMarkup(createElement(StatusMark, { status: 'needs-you' })));
    expect(mark?.slice(1, 3)).toEqual(['needs-you', 'icons']);
    expect(mark?.[3]).toContain('status-mark-glyph');
    expect(mark?.[4]).toBe('Needs you');
  });

  it("swaps the glyph for the agent's character when given one, keeping the word", () => {
    const [mark] = marksIn(renderToStaticMarkup(createElement(StatusMark, { status: 'paused', character: { harness: 'codex', pose: 'hibernated' } })));
    expect(mark?.[2]).toBe('bean');
    expect(mark?.[3]).not.toContain('status-mark-glyph');
    expect(mark?.[3]).toMatch(/data-testid="tile-character" data-pose="hibernated" data-harness="codex"/);
    expect(mark?.[4]).toBe('Paused');
  });
});

describe('the status mark gallery', () => {
  it('shows every status as its glyph and as a character, each pose its own', () => {
    const marks = marksIn(renderToStaticMarkup(createElement(StatusMarkGallery)));
    expect(marks.map((mark) => `${mark[1]}/${mark[2]}`)).toEqual(HUMAN_STATUSES.flatMap((status) => [`${status}/icons`, `${status}/bean`]));
    const poses = marks.filter((mark) => mark[2] === 'bean').map((mark) => /data-pose="([^"]+)"/.exec(mark[3]!)?.[1]);
    expect(new Set(poses).size).toBe(HUMAN_STATUSES.length);
  });
});
