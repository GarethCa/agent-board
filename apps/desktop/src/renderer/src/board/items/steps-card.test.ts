import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step, StepsData, StepsWho } from '@agent-board/daemon/protocol';
import { KIND_ICON, StepsCard, type StepsCardActions } from './StepsCard';
import { StepsFull } from './StepsFull';
import type { StepsLookup } from './steps-view';

const USER: StepsWho = { kind: 'user' };
const AT = '2026-01-01T00:00:00.000Z';
let next = 0;
const step = (part: Partial<Step> & Pick<Step, 'text'>): Step => ({
  id: `s${next++}`,
  kind: 'todo',
  section: null,
  required: false,
  choices: [],
  who: USER,
  link: null,
  done: null,
  answer: null,
  ...part,
});
const card = (steps: Step[]): StepsData => ({ title: 'Cache plan', madeBy: USER, answeredBy: USER, steps, sent: null, waits: [], closedAt: null });
const LOOKUP: StepsLookup = { live: () => true, name: (sessionId) => sessionId };
const ACTIONS: StepsCardActions = { answer: () => {}, tick: () => {}, send: () => {}, stepIn: () => {}, leave: () => {} };

/** Where each class first shows in `html`, so a test can pin their order. */
function order(html: string, classes: string[]): number[] {
  return classes.map((name) => {
    const at = html.indexOf(`class="${name}"`);
    expect(at, `no .${name}`).toBeGreaterThan(-1);
    return at;
  });
}
const ascending = (at: number[]) => at.every((each, index) => index === 0 || each > at[index - 1]!);

describe('a choice question leads with its state dot, its kind after the text', () => {
  const question = step({ kind: 'one', text: 'Which store?', who: null, choices: ['Redis', 'SQLite'] });
  const data = card([step({ text: 'Pull main', done: { by: USER, at: AT } }), question]);

  it('on the card, the open head is dot, text, then the kind mark', () => {
    const html = renderToStaticMarkup(
      createElement(StepsCard, { data, lookup: LOOKUP, look: 'full', selected: true, steppedIn: false, writing: false, actions: ACTIONS }),
    );
    const head = html.slice(html.indexOf('class="steps-open-head"'), html.indexOf('class="steps-open-note"'));
    expect(ascending(order(head, ['steps-dot', 'steps-open-text', 'steps-kind steps-kind-trail']))).toBe(true);
    // One state mark: the kind is not a second dot beside it.
    expect(head.match(/class="steps-dot/g)).toHaveLength(1);
    expect(head).toContain('lucide-list-check');
  });

  it('no question kind is drawn round, so none looks like a state dot', () => {
    for (const [kind, icon] of Object.entries(KIND_ICON)) {
      if (kind === 'todo') continue;
      expect(renderToStaticMarkup(icon as ReactElement), kind).not.toMatch(/lucide-circle/);
    }
  });

  describe('in full', () => {
    beforeEach(() => {
      vi.stubGlobal('HTMLElement', class {});
      vi.stubGlobal('document', { activeElement: null });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('each row is state, place, text, kind, then the state word', () => {
      const html = renderToStaticMarkup(createElement(StepsFull, { data, lookup: LOOKUP, actions: ACTIONS, onClose: () => {}, inline: true }));
      const rows = [...html.matchAll(/<li class="steps-full-step"/g)].map((match) => html.slice(match.index, html.indexOf('</li>', match.index)));
      expect(rows).toHaveLength(2);
      const choice = rows.find((row) => row.includes('data-question'))!;
      const todo = rows.find((row) => !row.includes('data-question'))!;
      expect(ascending(order(choice, ['steps-dot', 'steps-full-place', 'steps-full-text', 'steps-kind steps-kind-trail', 'steps-full-state']))).toBe(true);
      // A to-do keeps the kind column, empty, after its text, so the state words stay in line.
      expect(ascending(order(todo, ['steps-full-place', 'steps-full-text', 'steps-kind', 'steps-full-state']))).toBe(true);
      expect(todo).not.toContain('steps-kind-trail');
    });
  });
});
