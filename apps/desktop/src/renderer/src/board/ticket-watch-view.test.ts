import { describe, expect, it } from 'vitest';
import type { TicketWatch, TicketWatchNews } from '@agent-board/daemon/protocol';
import { untoldNews, watchIcons, watchLine, watchesOn } from './ticket-watch-view';

const AT = '2026-11-14T09:00:00.000Z';
const off = { tile: false, chat: false };
const tile = { tile: true, chat: false };
const both = { tile: true, chat: true };

const SEEN: NonNullable<TicketWatch['seen']> = {
  lastReview: { by: 'sam', state: 'CHANGES_REQUESTED', at: AT },
  approvals: { by: [], decision: 'CHANGES_REQUESTED' },
  merge: { state: 'open', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
  checks: { state: 'passing', passing: 2, total: 2 },
};

const watchOf = (fields: Partial<TicketWatch> = {}): TicketWatch => ({
  settings: { reviews: off, approvals: off, merge: off, checks: off, everyMinutes: 5 },
  pullRequest: { repo: 'acme/app', number: 648, url: 'https://github.com/acme/app/pull/648', state: 'open' },
  seen: SEEN,
  news: [],
  ask: null,
  checkedAt: AT,
  problem: null,
  ...fields,
});
const news = (kind: TicketWatchNews['kind'], text: string, by: string | null = null): TicketWatchNews => ({ kind, text, at: AT, by });
const settings = (on: Partial<TicketWatch['settings']>) => ({ ...watchOf().settings, ...on });

describe("a ticket tile's watch icons", () => {
  it('shows none until a watch is on, then one for each, grey while nothing is new', () => {
    expect(watchIcons(undefined, true)).toEqual([]);
    expect(watchIcons(watchOf(), true)).toEqual([]);
    const icons = watchIcons(watchOf({ settings: settings({ reviews: tile, checks: { tile: false, chat: true } }) }), true);
    expect(icons.map(({ kind, label, tone }) => ({ kind, label, tone }))).toEqual([
      { kind: 'reviews', label: 'sam', tone: 'quiet' },
      { kind: 'checks', label: '2/2', tone: 'good' },
    ]);
    expect(icons[0]!.title).toBe('Human reviews: sam requested changes');
  });

  it('turns blue while its kind has news the tile shows to read', () => {
    const [icon] = watchIcons(watchOf({ settings: settings({ reviews: tile }), news: [news('reviews', 'sam requested changes', 'sam')] }), true);
    expect(icon).toMatchObject({ tone: 'new', title: 'Human reviews: sam requested changes · news to read' });
  });

  it('stays its own colour while the tile shows no news to read: something else asks, or it merged', () => {
    const [icon] = watchIcons(watchOf({ settings: settings({ reviews: tile }), news: [news('reviews', 'sam requested changes', 'sam')] }), false);
    expect(icon).toMatchObject({ tone: 'quiet', title: 'Human reviews: sam requested changes' });
  });

  it('leaves news its chat was told to the chat: not blue', () => {
    const [icon] = watchIcons(watchOf({ settings: settings({ reviews: both }), news: [news('reviews', 'sam requested changes', 'sam')] }), true);
    expect(icon).toMatchObject({ tone: 'quiet' });
  });

  it('keeps orange and green over blue, so a failing check still reads as the user’s to fix', () => {
    const on = settings({ merge: tile, checks: tile });
    const icons = watchIcons(
      watchOf({ settings: on, seen: { ...SEEN, merge: { state: 'merged', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, checks: { state: 'failing', passing: 1, total: 3 } }, news: [news('merge', 'Merged'), news('checks', 'Checks failing: 1 of 3 passing')] }),
      true,
    );
    expect(icons.map(({ tone }) => tone)).toEqual(['good', 'bad']);
    expect(icons[1]!.title).toBe('Checks (CI): failing, 1 of 3 passing · news to read');
  });

  it('hides its grey watches when asked, and words the rest as if only they were on', () => {
    const all = settings({ reviews: tile, approvals: tile, merge: tile, checks: tile });
    const seen = { ...SEEN, approvals: { by: ['sam'], decision: 'APPROVED' }, checks: { state: 'pending' as const, passing: 1, total: 3 } };
    const icons = watchIcons(watchOf({ settings: all, seen, news: [news('reviews', 'sam requested changes', 'sam')], ask: 'new-review' }), true, { quiet: false });
    // Merge open and checks running are grey: two watches are left, with room for their words.
    expect(icons.map(({ kind, label, tone }) => ({ kind, label, tone }))).toEqual([
      { kind: 'reviews', label: 'sam', tone: 'new' },
      { kind: 'approvals', label: '1', tone: 'good' },
    ]);
  });

  it('drops every word past two watches, so the row keeps room for its helpers and pull request', () => {
    const all = settings({ reviews: tile, approvals: tile, merge: tile, checks: tile });
    const seen = { ...SEEN, approvals: { by: ['sam'], decision: 'APPROVED' }, checks: { state: 'failing' as const, passing: 1, total: 3 } };
    const icons = watchIcons(watchOf({ settings: all, seen, news: [news('reviews', 'sam requested changes', 'sam')], ask: 'new-review' }), true);
    expect(icons.map(({ kind, label, tone }) => ({ kind, label, tone }))).toEqual([
      { kind: 'reviews', label: undefined, tone: 'new' },
      { kind: 'approvals', label: undefined, tone: 'good' },
      { kind: 'merge', label: undefined, tone: 'quiet' },
      { kind: 'checks', label: undefined, tone: 'bad' },
    ]);
    // Its tooltip still says it all.
    expect(icons[3]!.title).toBe('Checks (CI): failing, 1 of 3 passing');
  });

  it('names someone outside the repo without saying how they reviewed', () => {
    const [icon] = watchIcons(watchOf({ settings: settings({ reviews: tile }), seen: { ...SEEN, lastReview: { by: 'stranger', state: '', at: AT } } }), true);
    expect(icon).toMatchObject({ label: 'stranger', title: 'Human reviews: last from @stranger' });
  });

  it("says the repo's rules approve, not who, when no person of the repo's did", () => {
    const on = settings({ approvals: tile });
    const [rules] = watchIcons(watchOf({ settings: on, seen: { ...SEEN, approvals: { by: [], decision: 'APPROVED' } } }), true);
    expect(rules).toMatchObject({ label: undefined, tone: 'good', title: 'Approval status: approved under the repo’s rules' });
    const [people] = watchIcons(watchOf({ settings: on, seen: { ...SEEN, approvals: { by: ['sam', 'priya'], decision: 'APPROVED' } } }), true);
    expect(people).toMatchObject({ label: '2', tone: 'good', title: 'Approval status: approved by sam, priya' });
  });

  it('marks a conflict, a branch behind its base and failing checks for the user, and a merge as good', () => {
    const on = settings({ merge: tile, checks: tile });
    const tones = (seen: Partial<NonNullable<TicketWatch['seen']>>) => watchIcons(watchOf({ settings: on, seen: { ...SEEN, ...seen } }), true).map((icon) => icon.tone);
    expect(tones({ merge: { state: 'open', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, checks: { state: 'failing', passing: 1, total: 3 } })).toEqual(['bad', 'bad']);
    expect(tones({ merge: { state: 'open', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' } })).toEqual(['bad', 'good']);
    expect(tones({ merge: { state: 'merged', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } })).toEqual(['good', 'good']);
  });

  it('waits for its first read before it says anything', () => {
    expect(watchIcons(watchOf({ settings: settings({ merge: both }), seen: null }), true)).toEqual([{ kind: 'merge', label: undefined, tone: 'quiet', title: 'Merge status: not read yet' }]);
  });
});

describe("the card's line from its watches", () => {
  it('is the newest review while it asks New review, with its pull request', () => {
    const watch = watchOf({ settings: settings({ reviews: tile, approvals: tile }), ask: 'new-review', news: [news('reviews', 'tom reviewed', 'tom'), news('approvals', 'sam approved', 'sam')] });
    expect(watchLine(watch)).toEqual({ text: 'sam approved on #648.', review: true });
  });

  it('is its newest merge or check news, quietly, when no review asks', () => {
    const watch = watchOf({ settings: settings({ merge: tile, checks: tile }), news: [news('merge', 'Behind its base branch'), news('checks', 'Checks failing: 1 of 3 passing')] });
    expect(watchLine(watch)).toEqual({ text: 'Checks failing: 1 of 3 passing.', review: false });
  });

  it("leaves the line to the chat when the chat was told the news", () => {
    const watch = watchOf({ settings: settings({ reviews: both, checks: both }), news: [news('reviews', 'sam requested changes', 'sam'), news('checks', 'Checks failing: 1 of 3 passing')] });
    expect(untoldNews(watch)).toEqual([]);
    expect(watchLine(watch)).toBeUndefined();
    expect(watchLine(undefined)).toBeUndefined();
  });

  it('lists the watches that are on in their order', () => {
    expect(watchesOn(watchOf({ settings: settings({ checks: both, reviews: { tile: false, chat: true } }) }))).toEqual(['reviews', 'checks']);
  });
});
