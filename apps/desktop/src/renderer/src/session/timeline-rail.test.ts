import { describe, expect, test } from 'vitest';
import type { ChatItem, ToolCall } from './chat';
import { railTurns } from './timeline-rail';

const call = (id: string, name: string, at?: string): ToolCall => ({ kind: 'call', id, name, input: {}, ...(at === undefined ? {} : { at }) });

/** Each segment as a line: a message said to the agent, or a turn's steps, each with the time it shows beside it. */
const outline = (items: ChatItem[]) =>
  railTurns(items).map((segment) =>
    segment.kind === 'said' ? `said ${segment.item.text}` : segment.kind === 'hidden' ? 'hidden' : segment.steps.map((step) => `${step.at ?? '-'} ${step.kind === 'call' ? step.call.id : step.key}`).join(' | '),
  );

describe('the Timeline rail', () => {
  test('leaves what was said to the agent off the rail, and rails everything between as one turn', () => {
    const items: ChatItem[] = [
      { kind: 'user', key: 'u1', text: 'Review it', at: '2026-10-31T09:14:05Z' },
      { kind: 'thinking', key: 't1', text: '', at: '2026-10-31T09:14:06Z' },
      { kind: 'assistant', key: 'a1', text: 'On it.', at: '2026-10-31T09:14:07Z' },
      { kind: 'user', key: 'u2', text: 'Thanks', at: '2026-10-31T09:20:00Z' },
      { kind: 'assistant', key: 'a2', text: 'Done.', at: '2026-10-31T09:20:30Z' },
    ];
    expect(outline(items)).toEqual(['said Review it', '2026-10-31T09:14:06Z t1 | - a1', 'said Thanks', '2026-10-31T09:20:30Z a2']);
  });

  test('puts every call of a run on the rail as its own step', () => {
    const items: ChatItem[] = [
      { kind: 'tools', key: 'run', rows: [call('c1', 'Read', '2026-10-31T09:14:00Z'), call('c2', 'Read', '2026-10-31T09:14:10Z'), call('c3', 'Grep', '2026-10-31T09:15:02Z')] },
    ];
    expect(outline(items)).toEqual(['2026-10-31T09:14:00Z c1 | - c2 | 2026-10-31T09:15:02Z c3']);
  });

  test('shows a time beside a step only when its minute is not the one last shown', () => {
    const items: ChatItem[] = [
      { kind: 'assistant', key: 'a1', text: 'One', at: '2026-10-31T09:14:59Z' },
      { kind: 'notice', key: 'n1', text: 'Untimed' },
      { kind: 'assistant', key: 'a2', text: 'Two', at: '2026-10-31T09:14:01Z' },
      { kind: 'assistant', key: 'a3', text: 'Three', at: '2026-10-31T09:15:00Z' },
    ];
    expect(outline(items)).toEqual(['2026-10-31T09:14:59Z a1 | - n1 | - a2 | 2026-10-31T09:15:00Z a3']);
  });

  test('starts each turn with its time again, though the minute is the same', () => {
    const items: ChatItem[] = [
      { kind: 'assistant', key: 'a1', text: 'One', at: '2026-10-31T09:14:01Z' },
      { kind: 'user', key: 'u1', text: 'And?', at: '2026-10-31T09:14:02Z' },
      { kind: 'assistant', key: 'a2', text: 'Two', at: '2026-10-31T09:14:03Z' },
    ];
    expect(outline(items)).toEqual(['2026-10-31T09:14:01Z a1', 'said And?', '2026-10-31T09:14:03Z a2']);
  });

  test('leaves the call the live line stands at off the rail, and a run with nothing else draws no step', () => {
    const items: ChatItem[] = [
      { kind: 'tools', key: 'r1', rows: [call('c1', 'Read'), call('c2', 'Write')] },
      { kind: 'user', key: 'u1', text: 'Go on' },
      { kind: 'tools', key: 'r2', rows: [call('c3', 'Write')] },
    ];
    expect(railTurns(items, 'c3').map((segment) => (segment.kind !== 'turn' ? segment.kind : segment.steps.length))).toEqual([2, 'said']);
    expect(railTurns(items, 'c2').map((segment) => (segment.kind !== 'turn' ? segment.kind : segment.steps.map((step) => (step.kind === 'call' ? step.call.id : '')).join()))).toEqual(['c1', 'said', 'c3']);
  });

  test('marks the calls of the last run in the conversation, which may still be running', () => {
    const items: ChatItem[] = [
      { kind: 'tools', key: 'r1', rows: [call('c1', 'Read')] },
      { kind: 'assistant', key: 'a1', text: 'Next' },
      { kind: 'tools', key: 'r2', rows: [call('c2', 'Read'), call('c3', 'Write')] },
    ];
    const calls = railTurns(items).flatMap((segment) => (segment.kind === 'turn' ? segment.steps : [])).flatMap((step) => (step.kind === 'call' ? [`${step.call.id} ${step.lastRun ?? false}`] : []));
    expect(calls).toEqual(['c1 false', 'c2 true', 'c3 true']);
  });

  test('leaves the agents\' messages hidden off the rail, ending the turn before them', () => {
    const items: ChatItem[] = [
      { kind: 'assistant', key: 'a1', text: 'One', at: '2026-10-31T09:14:01Z' },
      { kind: 'agents-hidden', key: 'h1', count: 2 },
      { kind: 'assistant', key: 'a2', text: 'Two', at: '2026-10-31T09:14:03Z' },
    ];
    expect(railTurns(items).map((segment) => (segment.kind === 'turn' ? segment.steps.map((step) => `${step.at ?? '-'} ${step.key}`).join(' | ') : segment.kind))).toEqual([
      '2026-10-31T09:14:01Z a1',
      'hidden',
      '2026-10-31T09:14:03Z a2',
    ]);
  });

  test('leaves a message another agent sent off the rail too, as what was said to the agent', () => {
    const items: ChatItem[] = [{ kind: 'user', key: 'u1', text: 'Hand-off', from: { ref: 'agent:1', name: 'Captain', kind: 'send' } }];
    expect(railTurns(items)).toEqual([{ kind: 'said', item: items[0] }]);
  });
});
