import { describe, expect, it } from 'vitest';
import { answerBanner, bannerOf, MAX_ANSWERS } from './banner';
import type { AppNotification } from './notifications-types';

const note = (fields: Partial<AppNotification>): AppNotification => ({
  sessionId: 'a',
  kind: 'flagged',
  name: 'Fix login redirect',
  title: 'Fix login redirect needs you',
  body: 'PR #241 is ready for review.',
  ...fields,
});

describe('bannerOf', () => {
  it('keeps the classic banner as it was: the sentence as title, no subtitle, no buttons', () => {
    expect(bannerOf(note({}), false)).toEqual({ title: 'Fix login redirect needs you', body: 'PR #241 is ready for review.', answers: [] });
  });

  it('draws the Simplified banner as macOS does: the agent, what kind of request, then the request', () => {
    expect(bannerOf(note({}), true)).toEqual({ title: 'Fix login redirect', subtitle: 'Needs you', body: 'PR #241 is ready for review.', answers: [] });
  });

  it('leaves the app’s own notifications as they are', () => {
    expect(bannerOf({ title: 'Test notification', body: 'Hello.' }, true)).toEqual({ title: 'Test notification', body: 'Hello.', answers: [] });
  });

  it('lists a question’s answers as the banner’s options', () => {
    const ask = { askId: 'q1', question: 'Where after sign-in?', options: ['The page they were on', 'Home'] };
    const banner = bannerOf(note({ kind: 'asks', body: 'Where after sign-in? (The page they were on · Home)', ask }), true);

    expect(banner.subtitle).toBe('Question');
    expect(banner.answers).toEqual(['The page they were on', 'Home']);
    // Not said twice: the answers are the buttons.
    expect(banner.body).toBe('Where after sign-in?');
  });

  it('offers no answer on a question in Classic', () => {
    const ask = { askId: 'q1', question: 'Redis?', options: ['Yes', 'No'] };

    expect(bannerOf(note({ kind: 'asks', ask }), false).answers).toEqual([]);
  });

  it('offers none for a question with more options than a banner lists, and keeps them in its body', () => {
    const options = Array.from({ length: MAX_ANSWERS + 1 }, (_, i) => `Option ${i}`);
    const body = `Which? (${options.join(' · ')})`;

    const banner = bannerOf(note({ kind: 'asks', body, ask: { askId: 'q1', question: 'Which?', options } }), true);

    expect(banner.answers).toEqual([]);
    expect(banner.body).toBe(body);
  });

  it('never offers to allow: a permission banner opens the agent and nothing else', () => {
    // Even a notification that somehow carried an ask offers nothing once it is a permission.
    const banner = bannerOf(note({ kind: 'permission', ask: { askId: 'q1', question: 'Allow?', options: ['Allow'] } }), true);

    expect(banner.subtitle).toBe('Permission');
    expect(banner.answers).toEqual([]);
  });
});

describe('answerBanner', () => {
  const ask = { askId: 'q7', question: 'Which?', options: ['Redis', 'CDN only'] };
  const tools = (answer: () => Promise<unknown>) => {
    const opened: string[] = [];
    const asked: unknown[] = [];
    return { opened, asked, tools: { answer: (params: unknown) => (asked.push(params), answer()), openAgent: (id: string) => void opened.push(id) } };
  };

  it('answers the question with the option picked, by its place in the list', async () => {
    const { tools: given, asked, opened } = tools(() => Promise.resolve(null));

    answerBanner(note({ kind: 'asks', ask }), 1, given);
    await Promise.resolve();

    expect(asked).toEqual([{ sessionId: 'a', askId: 'q7', answer: { option: 1 } }]);
    expect(opened).toEqual([]);
  });

  it('opens the agent when the daemon refuses, as the question is no longer asked', async () => {
    const { tools: given, opened } = tools(() => Promise.reject(new Error('the agent no longer asks it')));

    answerBanner(note({ kind: 'asks', ask }), 0, given);
    await new Promise((resolve) => setImmediate(resolve));

    expect(opened).toEqual(['a']);
  });
});
