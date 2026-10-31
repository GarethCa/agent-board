import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HUMAN_STATUSES } from '@agent-board/daemon/human-status';
import { StatusMark } from './StatusMark';
import { StatusMarkGallery } from './StatusMarkGallery';
import { statusLookOf } from './status-look';

const marksIn = (html: string) => [...html.matchAll(/<span class="status-mark"[^>]*data-status="([^"]+)" data-look="([^"]+)">(.*?)<span class="status-mark-word">([^<]+)<\/span><\/span>/g)];

describe('a status mark', () => {
  it('draws a glyph and the word by default', () => {
    const [mark] = marksIn(renderToStaticMarkup(createElement(StatusMark, { status: 'needs-you' })));
    expect(mark?.slice(1, 3)).toEqual(['needs-you', 'icons']);
    expect(mark?.[3]).toContain('status-mark-glyph');
    expect(mark?.[4]).toBe('Needs you');
  });

  it('swaps the glyph for the orange character with Characters, keeping the word', () => {
    const [mark] = marksIn(renderToStaticMarkup(createElement(StatusMark, { status: 'paused', look: 'characters' })));
    expect(mark?.[3]).not.toContain('status-mark-glyph');
    expect(mark?.[3]).toMatch(/data-testid="character" data-pose="idle" data-harness="claude"/);
    expect(mark?.[4]).toBe('Paused');
  });
});

describe('the status mark gallery', () => {
  it('shows every status in both looks, each pose its own', () => {
    const marks = marksIn(renderToStaticMarkup(createElement(StatusMarkGallery)));
    expect(marks.map((mark) => `${mark[1]}/${mark[2]}`)).toEqual(HUMAN_STATUSES.flatMap((status) => [`${status}/icons`, `${status}/characters`]));
    const poses = marks.filter((mark) => mark[2] === 'characters').map((mark) => /data-pose="([^"]+)"/.exec(mark[3]!)?.[1]);
    expect(new Set(poses).size).toBe(HUMAN_STATUSES.length);
  });
});

describe('the picked status look', () => {
  it('is icons and words unless Characters is stored', () => {
    expect(statusLookOf(undefined)).toBe('icons');
    expect(statusLookOf('sparkles')).toBe('icons');
    expect(statusLookOf('characters')).toBe('characters');
  });
});
