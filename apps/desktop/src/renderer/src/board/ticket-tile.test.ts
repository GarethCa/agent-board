import { describe, expect, it } from 'vitest';
import type { Agent, AgentState, NeedsYouShows, PullRequest, TicketWatch, TicketWatchNews } from '@agent-board/daemon/protocol';
import { galleryAgent } from './TileGallery';
import { ticketHead, ticketTileAsk, helperIcon, midRowFits, TICKET_ASKS, ticketAsk, ticketFace, type TicketAsk } from './ticket-tile';

const AT = '2026-11-14T09:00:00.000Z';
const SHOWS: NeedsYouShows = 'explicit';
const status = (summary: string) => ({ summary, progress: null, updatedAt: AT, setBy: null });
const pr = (number: number, state: PullRequest['state'] = 'open', checks: PullRequest['checks'] = 'passing'): PullRequest => ({ number, title: 'A change', url: '', state, checks });
const issue = { provider: 'linear', id: 'ACME-726', title: 'Ticket tiles', url: '' } as Agent['issue'];
const chat = (state: AgentState, fields: Partial<Agent> = {}): Agent => ({ ...galleryAgent(state), sessionId: 'chat', name: 'ACME-726', ticketChat: true, issue, pullRequests: [], ...fields });
const helper = (id: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({
  ...galleryAgent(state),
  sessionId: id,
  name: id,
  ticket: 'chat',
  ledBy: 'chat',
  spawnedBy: 'chat',
  pullRequests: [],
  ...fields,
});
const ask = { question: 'Two minutes or five?', options: [], at: AT } as unknown as Agent['ask'];
const off = { tile: false, chat: false };
const watch = (fields: Partial<TicketWatch> = {}): TicketWatch => ({
  settings: { reviews: { tile: true, chat: false }, approvals: off, merge: off, checks: { tile: true, chat: false }, everyMinutes: 5 },
  pullRequest: { repo: 'acme/app', number: 648, url: '', state: 'open' },
  seen: null,
  news: [],
  ask: null,
  checkedAt: AT,
  problem: null,
  ...fields,
});
const news = (kind: TicketWatchNews['kind'], text: string): TicketWatchNews => ({ kind, text, at: AT, by: null });
const ready = { category: 'ready-for-review' as const, label: null, waitingOn: null, setAt: AT, setBy: null };

describe('the one thing a ticket tile asks for', () => {
  it('goes Needs you, then Ready to merge, then New review, then Working', () => {
    expect(TICKET_ASKS).toEqual(['needs-you', 'ready-to-merge', 'new-review', 'working']);
    const cases: [boolean, boolean, boolean, TicketAsk][] = [
      [true, true, true, 'needs-you'],
      [true, false, false, 'needs-you'],
      [false, true, true, 'ready-to-merge'],
      [false, true, false, 'ready-to-merge'],
      [false, false, true, 'new-review'],
      [false, false, false, 'working'],
    ];
    for (const [needsYou, readyToMerge, newReview, expected] of cases) expect(ticketAsk({ needsYou, readyToMerge, newReview })).toBe(expected);
  });
});

describe('the ticket tile’s face', () => {
  it('heads with its ticket and the ticket’s title, and says what its chat is working to', () => {
    const face = ticketFace(chat('running', { status: status('Builder is adding the watch settings') }), [helper('builder', 'running', { role: 'implementer' })], SHOWS);
    expect(face).toMatchObject({ ticketId: 'ACME-726', title: 'Ticket tiles', ask: 'working', word: 'Working', flat: false, line: 'Builder is adding the watch settings', button: undefined });
  });

  it('falls back to the chat’s name with no issue, which a rename then changes', () => {
    expect(ticketFace(chat('running', { issue: null, name: 'Tidy the docs' }), [], SHOWS)).toMatchObject({ ticketId: undefined, title: 'Tidy the docs', renames: true });
  });

  it('offers no rename while its title is its ticket’s', () => {
    expect(ticketFace(chat('running'), [], SHOWS).renames).toBe(false);
  });

  it('works while a helper does, though its chat sits idle', () => {
    const face = ticketFace(chat('idle', { status: null, lastMessage: null }), [helper('builder', 'running', { status: status('Writing the tests') })], SHOWS);
    expect(face).toMatchObject({ ask: 'working', word: 'Working', flat: false, line: 'builder: Writing the tests' });
  });

  it('rolls a helper’s question up into the ticket, and opens that helper', () => {
    const builder = helper('builder', 'waiting', { ask, lastMessage: 'Retry for two minutes or five?' });
    const face = ticketFace(chat('running'), [builder], SHOWS);
    expect(face).toMatchObject({ ask: 'needs-you', word: 'Needs you', flat: false, line: 'Its builder asks: Retry for two minutes or five?', needsYouNow: true });
    expect(face.button).toEqual({ kind: 'open', label: 'Answer', prominent: true });
    expect(face.asker.sessionId).toBe('builder');
  });

  it('asks for the chat before a helper', () => {
    const face = ticketFace(chat('waiting', { ask, lastMessage: 'Which option?' }), [helper('builder', 'waiting', { ask })], SHOWS);
    expect(face.asker.sessionId).toBe('chat');
    expect(face.line).toBe('Which option?');
  });

  it('does not count a helper’s finished turn: that is its chat’s to handle', () => {
    expect(ticketFace(chat('running'), [helper('builder', 'waiting')], 'turns').ask).toBe('working');
  });

  it('is ready to merge once its chat says the work is ready, its pull request is open and its checks pass', () => {
    const face = ticketFace(chat('idle', { workCategory: ready, pullRequests: [pr(647)], status: status('Approved. Checks pass.') }), [helper('builder', 'done', { endedAt: AT })], SHOWS);
    expect(face).toMatchObject({ ask: 'ready-to-merge', word: 'Ready to merge', flat: false, line: 'Approved. Checks pass.' });
    expect(face.button).toEqual({ kind: 'merge', label: 'Merge', prominent: true });
    expect(face.pr?.number).toBe(647);
  });

  it('finds its pull request on a helper too', () => {
    expect(ticketFace(chat('idle', { workCategory: ready }), [helper('builder', 'idle', { pullRequests: [pr(648)] })], SHOWS)).toMatchObject({ ask: 'ready-to-merge', pr: { number: 648 } });
  });

  it('is not ready to merge while checks fail or run, the pull request is a draft, or something still works', () => {
    const notYet = (fields: Partial<Agent>, helpers: Agent[] = []) => ticketFace(chat('idle', { workCategory: ready, ...fields }), helpers, SHOWS).ask;
    expect(notYet({ pullRequests: [pr(1, 'open', 'failing')] })).toBe('working');
    expect(notYet({ pullRequests: [pr(1, 'open', 'pending')] })).toBe('working');
    expect(notYet({ pullRequests: [pr(1, 'draft')] })).toBe('working');
    expect(notYet({ pullRequests: [pr(1)] }, [helper('reviewer', 'running')])).toBe('working');
    expect(notYet({ pullRequests: [pr(1)], workCategory: null })).toBe('working');
  });

  it('asks for the user over a ready merge', () => {
    expect(ticketFace(chat('idle', { workCategory: ready, pullRequests: [pr(1)] }), [helper('builder', 'waiting', { ask })], SHOWS).ask).toBe('needs-you');
  });

  it('lies flat once its pull request merged, says so, and offers nothing', () => {
    const face = ticketFace(chat('idle', { pullRequests: [pr(645, 'merged')] }), [helper('builder', 'done', { endedAt: AT })], SHOWS);
    expect(face).toMatchObject({ ask: 'working', word: 'Done', flat: true, merged: true, line: 'Merged as #645.', button: undefined, pr: { number: 645 } });
  });

  it('still asks for the user after the merge', () => {
    const face = ticketFace(chat('waiting', { ask, pullRequests: [pr(645, 'merged')] }), [], SHOWS);
    expect(face).toMatchObject({ ask: 'needs-you', flat: false });
  });

  it('lies flat as a tile does when nothing works and nothing asks', () => {
    expect(ticketFace(chat('idle', { status: null }), [helper('builder', 'idle')], SHOWS)).toMatchObject({ word: 'Idle', flat: true });
  });

  it('wakes a paused chat', () => {
    const face = ticketFace(chat('hibernated', { hibernated: { at: AT, by: null, byId: null } }), [], SHOWS);
    expect(face).toMatchObject({ word: 'Paused', flat: true, button: { kind: 'wake', label: 'Wake', prominent: false } });
  });

  it('opens a failed chat, by a danger dot', () => {
    expect(ticketFace(chat('failed', { notice: 'It crashed.' }), [], SHOWS)).toMatchObject({ word: 'Failed', wordKind: 'failed', line: 'It crashed.', button: { kind: 'open', label: 'Open', prominent: false } });
  });

  it('asks to resume a chat a restart stopped, on its card', () => {
    const face = ticketFace(chat('stopped-by-restart'), [helper('builder', 'idle')], SHOWS);
    expect(face).toMatchObject({ ask: 'needs-you', line: 'Stopped by a restart · Resume carries it on', button: { kind: 'wake', label: 'Resume', prominent: true } });
  });

  it('asks to resume a helper a restart stopped, and says who it is without saying it asks', () => {
    const face = ticketFace(chat('idle'), [helper('builder', 'stopped-by-restart')], SHOWS);
    expect(face).toMatchObject({ ask: 'needs-you', line: 'Its builder: Stopped by a restart · Resume carries it on', button: { kind: 'wake', label: 'Resume', prominent: true } });
    expect(face.asker.sessionId).toBe('builder');
  });

  it('lists its helpers as icons, in order', () => {
    const face = ticketFace(chat('running'), [helper('designer', 'done', { roleName: 'designer', endedAt: AT }), helper('builder', 'running', { role: 'implementer' }), helper('reviewer', 'idle', { role: 'reviewer', reviewOf: 'builder' })], SHOWS);
    expect(face.helpers.map(({ sessionId, kind, state }) => [sessionId, kind, state])).toEqual([
      ['designer', 'design', 'done'],
      ['builder', 'build', 'working'],
      ['reviewer', 'review', 'sleep'],
    ]);
  });
});

describe('the ticket tile’s watches', () => {
  it('asks New review with the review as its line and Read as its button, while its chat was not told', () => {
    const face = ticketFace(chat('running', { status: status('Adding the retries'), watch: watch({ news: [news('reviews', 'sam reviewed')], ask: 'new-review' }) }), [], SHOWS);
    expect(face).toMatchObject({ ask: 'new-review', word: 'New review', wordKind: 'new', line: 'sam reviewed on #648.', news: true });
    expect(face.button).toEqual({ kind: 'read', label: 'Read', prominent: true });
  });

  it('leaves a new review to Needs you and Ready to merge, which come first', () => {
    const face = ticketFace(chat('waiting', { ask, lastMessage: 'Which option?', watch: watch({ news: [news('reviews', 'sam approved')], ask: 'new-review' }) }), [], SHOWS);
    expect(face).toMatchObject({ ask: 'needs-you', line: 'Which option?', news: false });
  });

  it('says quiet news as its line, with a quiet Read, while it asks for nothing else', () => {
    const face = ticketFace(chat('idle', { status: null, lastMessage: null, watch: watch({ news: [news('checks', 'Checks failing: 1 of 3 passing')] }) }), [], SHOWS);
    expect(face).toMatchObject({ ask: 'working', line: 'Checks failing: 1 of 3 passing.', news: true });
    expect(face.button).toEqual({ kind: 'read', label: 'Read', prominent: false });
  });

  it('keeps its chat’s line when its chat was told the news, and its watch icons their own colour', () => {
    const told = watch({ settings: { ...watch().settings, reviews: { tile: true, chat: true } }, news: [news('reviews', 'sam approved')] });
    const face = ticketFace(chat('running', { status: status('Adding the retries'), watch: told }), [], SHOWS);
    expect(face).toMatchObject({ ask: 'working', line: 'Adding the retries', news: false, button: undefined });
    expect(face.watches.map(({ kind, tone }) => ({ kind, tone }))).toEqual([
      { kind: 'reviews', tone: 'quiet' },
      { kind: 'checks', tone: 'quiet' },
    ]);
  });

  it('in Simplified, hides its grey watches, and gives who builds its word back once none is left', () => {
    const review = watch({ news: [news('reviews', 'sam approved')], ask: 'new-review' });
    const reading = ticketFace(chat('running', { status: status('Adding the retries'), watch: review }), [], SHOWS, { simplified: true });
    expect(reading.watches.map(({ kind, tone }) => ({ kind, tone }))).toEqual([{ kind: 'reviews', tone: 'new' }]);
    const quiet = ticketFace(chat('running', { status: status('Adding the retries'), watch: watch() }), [], SHOWS, { simplified: true });
    expect(quiet).toMatchObject({ watches: [], buildsWord: true });
    expect(ticketFace(chat('running', { status: status('Adding the retries'), watch: watch() }), [], SHOWS).watches).toHaveLength(2);
  });

  it('marks a watch blue only while its tile offers Read', () => {
    const review = watch({ news: [news('reviews', 'sam approved')], ask: 'new-review' });
    const asking = ticketFace(chat('waiting', { ask, lastMessage: 'Which option?', watch: review }), [], SHOWS);
    expect(asking.watches.map(({ tone }) => tone)).toEqual(['quiet', 'quiet']);
    const reading = ticketFace(chat('running', { status: status('Adding the retries'), watch: review }), [], SHOWS);
    expect(reading.watches.map(({ tone }) => tone)).toEqual(['new', 'quiet']);
  });

  it('goes quiet once merged: its merge watch green, nothing blue and nothing to press', () => {
    const merged = watch({
      settings: { ...watch().settings, merge: { tile: true, chat: false } },
      seen: { lastReview: null, approvals: { by: [], decision: 'APPROVED' }, merge: { state: 'merged', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, checks: { state: 'passing', passing: 2, total: 2 } },
      news: [news('reviews', 'sam approved'), news('merge', 'Merged')],
    });
    const face = ticketFace(chat('idle', { pullRequests: [pr(645, 'merged')], watch: merged }), [], SHOWS);
    expect(face).toMatchObject({ word: 'Done', flat: true, news: false, button: undefined });
    expect(face.watches.map(({ kind, tone }) => ({ kind, tone }))).toEqual([
      { kind: 'reviews', tone: 'quiet' },
      { kind: 'merge', tone: 'good' },
      { kind: 'checks', tone: 'good' },
    ]);
  });

  it('shows no watch icons with every watch off', () => {
    expect(ticketFace(chat('running'), [], SHOWS).watches).toEqual([]);
  });

  // Its middle row is one line: who builds, its helpers, its watches and its pull request. A watch is never cut off.
  it('keeps its watches’ words while its row has room, and drops them before any helper has to go', () => {
    const seen = { lastReview: { by: 'sam', state: 'COMMENTED', at: AT }, approvals: { by: [], decision: 'REVIEW_REQUIRED' }, merge: null, checks: { state: 'passing', passing: 2, total: 2 } } as unknown as TicketWatch['seen'];
    const lead = chat('running', { chatKind: 'lead', pullRequests: [pr(648, 'open')], watch: watch({ seen }) });
    const helpers = ['a', 'b', 'c'].map((id) => chat('running', { sessionId: `helper-${id}` }));
    const labels = (face: { watches: readonly { label: string | undefined }[] }) => face.watches.map(({ label }) => label);
    expect(labels(ticketFace(lead, helpers.slice(0, 1), SHOWS))).toEqual(['sam', '2/2']);
    expect(labels(ticketFace(lead, helpers, SHOWS))).toEqual([undefined, undefined]);
    // Beside the chat that builds, its builds mark keeps its hammer alone, and counts as one more icon on the left.
    const builds = ticketFace({ ...lead, chatKind: 'implementer' }, helpers.slice(0, 2), SHOWS);
    expect(builds.buildsWord).toBe(false);
    expect(labels(builds)).toEqual([undefined, undefined]);
  });

  it('fits its middle row by the widths of what is in it', () => {
    const icon = (label: string | undefined) => ({ kind: 'reviews' as const, label, tone: 'quiet' as const, title: '' });
    expect(midRowFits([icon('sam'), icon('2/2')], 1, false, true)).toBe(true);
    expect(midRowFits([icon('sam'), icon('2/2')], 3, false, true)).toBe(false);
    expect(midRowFits([icon('sam'), icon('2/2')], 2, true, true)).toBe(false);
    // A long name is cut at the label's widest, but still takes that room.
    expect(midRowFits([icon('a-very-long-reviewer-name')], 2, false, true)).toBe(true);
    expect(midRowFits([icon('a-very-long-reviewer-name'), icon('2/2')], 2, false, true)).toBe(false);
    // Without words there is nothing to drop.
    expect(midRowFits([icon(undefined), icon(undefined)], 6, true, true)).toBe(true);
  });

  it('keeps the builds mark’s word while no watch is on', () => {
    expect(ticketFace(chat('running', { chatKind: 'implementer' }), [], SHOWS).buildsWord).toBe(true);
  });
});

describe('a helper’s ask on its ticket’s tile', () => {
  it('names the helper who asks by its role, with what it asks, and Answer opens that helper', () => {
    const reviewer = helper('lens', 'waiting', { role: 'reviewer', ask, lastMessage: 'Keep the old order after a reload?' });
    const rolled = ticketTileAsk(chat('running'), [helper('builder', 'running'), reviewer], SHOWS);
    expect(rolled).toMatchObject({ word: 'Needs you', dot: true, line: 'Its reviewer asks: Keep the old order after a reload?', button: { kind: 'open', label: 'Answer', prominent: true }, needsYouNow: true });
    expect(rolled?.asker.sessionId).toBe('lens');
  });

  it('calls a design helper its designer, and any other its builder', () => {
    const designer = helper('pen', 'waiting', { roleName: 'Designer', ask, lastMessage: 'Which mock?' });
    expect(ticketTileAsk(chat('running'), [designer], SHOWS)?.line).toBe('Its designer asks: Which mock?');
    expect(ticketTileAsk(chat('running'), [helper('b', 'waiting', { ask, lastMessage: 'Which file?' })], SHOWS)?.line).toBe('Its builder asks: Which file?');
  });

  it('is none while no helper needs the user, or while the chat itself does, whose own ask its tile shows', () => {
    expect(ticketTileAsk(chat('running'), [helper('builder', 'running')], SHOWS)).toBeUndefined();
    expect(ticketTileAsk(chat('waiting', { ask }), [helper('builder', 'waiting', { ask })], SHOWS)).toBeUndefined();
  });

  it('asks Ready to merge with Merge, and New review with Read, from the chat itself and with no dot, standing up in their own colours', () => {
    const merge = ticketTileAsk(chat('idle', { workCategory: ready, pullRequests: [pr(647)], status: status('Approved. Checks pass.') }), [helper('builder', 'done', { endedAt: AT })], SHOWS);
    expect(merge).toMatchObject({ word: 'Ready to merge', wordKind: 'merge', flat: false, dot: false, line: 'Approved. Checks pass.', button: { kind: 'merge', label: 'Merge' }, needsYouNow: false });
    expect(merge?.asker.sessionId).toBe('chat');
    const review = ticketTileAsk(chat('running', { watch: watch({ news: [news('reviews', 'sam reviewed')], ask: 'new-review' }) }), [], SHOWS);
    expect(review).toMatchObject({ word: 'New review', wordKind: 'new', flat: false, dot: false, line: 'sam reviewed on #648.', button: { kind: 'read', label: 'Read' } });
  });

  it('says a merged ticket is Done, with its pull request, lying flat', () => {
    const merged = ticketTileAsk(chat('idle', { pullRequests: [pr(645, 'merged')] }), [helper('builder', 'done', { endedAt: AT })], SHOWS);
    expect(merged).toMatchObject({ word: 'Done', dot: false, flat: true, line: 'Merged as #645.', button: undefined });
  });

  it('keeps its needs-you look off once the helper was seen', () => {
    expect(ticketTileAsk(chat('running'), [helper('builder', 'waiting', { ask, seen: true })], SHOWS)?.needsYouNow).toBe(false);
  });
});

describe('a ticket’s name and about line', () => {
  it('shows the ticket’s title as the name of a chat named after its ticket alone, and its id alone in the about line', () => {
    expect(ticketHead(chat('running', { name: 'ACME-726', purpose: null, description: '' }))).toEqual({ name: 'Ticket tiles', id: 'ACME-726', about: undefined });
  });

  it('keeps a chat’s own name, its about line its id and what it is for', () => {
    expect(ticketHead(chat('running', { name: 'Retry flow', purpose: null, description: '' }))).toEqual({ name: 'Retry flow', id: 'ACME-726', about: 'Ticket tiles' });
    expect(ticketHead(chat('running', { name: 'ACME-726', purpose: 'Cap the retries', description: '' })).about).toBe('Cap the retries');
  });
});

describe('a helper’s icon', () => {
  it('is a lens for a reviewer, a pen for design, else a hammer', () => {
    expect(helperIcon(helper('r', 'running', { role: 'reviewer' }), SHOWS).kind).toBe('review');
    expect(helperIcon(helper('r', 'running', { role: 'follow-up-reviewer' }), SHOWS).kind).toBe('review');
    expect(helperIcon(helper('r', 'running', { reviewOf: 'b' }), SHOWS).kind).toBe('review');
    expect(helperIcon(helper('d', 'running', { role: 'custom', roleName: 'UI designer' }), SHOWS).kind).toBe('design');
    expect(helperIcon(helper('b', 'running', { role: 'implementer' }), SHOWS).kind).toBe('build');
    expect(helperIcon(helper('x', 'running'), SHOWS).kind).toBe('build');
  });

  it('asks while it needs the user, rings while it works, ticks once it is done, and sleeps otherwise', () => {
    expect(helperIcon(helper('b', 'waiting', { ask }), SHOWS).state).toBe('you');
    expect(helperIcon(helper('b', 'running'), SHOWS).state).toBe('working');
    expect(helperIcon(helper('b', 'thinking'), SHOWS).state).toBe('working');
    expect(helperIcon(helper('b', 'done', { endedAt: AT }), SHOWS).state).toBe('done');
    expect(helperIcon(helper('b', 'idle', { workFinishedAt: AT }), SHOWS).state).toBe('done');
    expect(helperIcon(helper('b', 'idle'), SHOWS).state).toBe('sleep');
    expect(helperIcon(helper('b', 'hibernated', { hibernated: { at: AT, by: null, byId: null } }), SHOWS).state).toBe('sleep');
    expect(helperIcon(helper('b', 'failed'), SHOWS).state).toBe('failed');
  });

  it('says who it is and what it is doing', () => {
    expect(helperIcon(helper('Builder', 'running'), SHOWS).title).toBe('Builder: working');
    expect(helperIcon(helper('Reviewer', 'done', { endedAt: AT }), SHOWS).title).toBe('Reviewer: done');
  });

  it('as a card has its name, its state in a word, and its status line under them, else what it is doing', () => {
    expect(helperIcon(helper('Builder', 'running', { status: status('Writing the tests') }), SHOWS)).toMatchObject({ name: 'Builder', word: 'Working', line: 'Writing the tests' });
    expect(helperIcon(helper('Reviewer', 'waiting', { ask, status: null }), SHOWS)).toMatchObject({ word: 'Needs you', line: 'Needs you' });
  });
});
