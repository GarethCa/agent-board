import { describe, expect, it } from 'vitest';
import { checkPrefabStart, checkStatusSet } from '../src/board-ops.ts';
import { queueUpdate, versionNumber } from '../src/queue-ops.ts';
import { stepNumber, stepsUpdate, stepWords } from '../src/steps-ops.ts';

// The one parser of each update, which the CLI's words and the MCP's arguments both go through.

describe('a steps update', () => {
  it('reads step numbers as typed or sent', () => {
    expect(stepNumber(3)).toBe(3);
    expect(stepNumber('12')).toBe(12);
    expect(() => stepNumber('two')).toThrow("give the step's number, from 1, not two");
    expect(() => stepNumber(0)).toThrow("give the step's number, from 1, not 0");
    expect(stepWords('2 3, 5')).toEqual(['2', '3', '5']);
  });

  it('ticks several steps at once, waits on one, and answers one', () => {
    expect(stepsUpdate({ action: 'done', steps: ['1', 3], undo: true })).toEqual({ action: 'done', steps: [1, 3], undo: true });
    expect(stepsUpdate({ action: 'tick', steps: ['2'] })).toEqual({ action: 'done', steps: [2], undo: false });
    expect(stepsUpdate({ action: 'wait', steps: [4] })).toEqual({ action: 'wait', step: 4 });
    expect(stepsUpdate({ action: 'answer', steps: [2], answer: 'Fri' })).toEqual({ action: 'answer', step: 2, answer: 'Fri', send: false });
    expect(stepsUpdate({ action: 'answer', send: true })).toEqual({ action: 'answer', send: true });
    expect(stepsUpdate({ action: 'add', text: '- [ ] Tag it' })).toEqual({ action: 'add', text: '- [ ] Tag it' });
    expect(stepsUpdate({ action: 'close' })).toEqual({ action: 'close' });
  });

  it('refuses what an action does not take', () => {
    expect(() => stepsUpdate({ action: 'done' })).toThrow('give the number of each step to tick');
    expect(() => stepsUpdate({ action: 'wait', steps: [1, 2] })).toThrow('give one step number to wait on');
    expect(() => stepsUpdate({ action: 'answer', steps: [2] })).toThrow('give the answer after the step number');
    expect(() => stepsUpdate({ action: 'answer' })).toThrow('give the step number and its answer, or send');
    expect(() => stepsUpdate({ action: 'add', text: '  ' })).toThrow('give the steps to add, one a line');
    expect(() => stepsUpdate({ action: 'close', steps: [1] })).toThrow('close takes no step number');
    expect(() => stepsUpdate({ action: 'shuffle' })).toThrow('the steps updates are done, wait, add, answer and close');
  });
});

describe('a queue update', () => {
  it('reads each action, and drain and restore numbers as typed or sent', () => {
    expect(queueUpdate({ action: 'add', text: 'Ship it', kind: 'task', front: true })).toEqual({ action: 'add', text: 'Ship it', kind: 'task', front: true });
    expect(queueUpdate({ action: 'take' })).toEqual({ action: 'take' });
    expect(() => versionNumber('latest')).toThrow('give the version to put back, as history lists it');
    expect(queueUpdate({ action: 'edit', job: '#1', text: '' , link: '' })).toEqual({ action: 'edit', job: '#1', link: '' });
    expect(queueUpdate({ action: 'rm', job: '#1' })).toEqual({ action: 'remove', job: '#1' });
    expect(queueUpdate({ action: 'restore', job: '#1', version: '4' })).toEqual({ action: 'restore', job: '#1', version: 4 });
    expect(queueUpdate({ action: 'drain', on: true, most: '2' })).toEqual({ action: 'drain', on: true, most: 2 });
    expect(queueUpdate({ action: 'drain', on: false, most: 3 })).toEqual({ action: 'drain', on: false, most: 3 });
  });

  it('refuses a headline of more than one line, a kind it has not, and a drain past three', () => {
    expect(() => queueUpdate({ action: 'add', text: 'One\nTwo', body: 'Detail' })).toThrow('with a body, give one headline: the body holds the rest');
    expect(queueUpdate({ action: 'add', text: 'One\n', body: 'Detail' })).toMatchObject({ text: 'One\n', body: 'Detail' });
    expect(() => queueUpdate({ action: 'add', text: 'x', kind: 'chore' })).toThrow('kind is one of task, request, prompt, info');
    expect(() => queueUpdate({ action: 'add', text: ' ' })).toThrow('give the jobs to queue, one a line');
    expect(() => queueUpdate({ action: 'edit', job: '#1' })).toThrow('give the new text, or a link');
    expect(() => queueUpdate({ action: 'drain', on: true, most: 4 })).toThrow('most is 1, 2 or 3');
    expect(() => queueUpdate({ action: 'drain' })).toThrow('give drain on or off');
    expect(() => queueUpdate({ action: 'move', job: '#1' })).toThrow('give where to move it');
  });
});

describe('a status set', () => {
  it('needs something to set, and progress with a summary', () => {
    expect(() => checkStatusSet({ summary: 'Wiring', progress: 40 })).not.toThrow();
    expect(() => checkStatusSet({})).toThrow('give a summary, a character, a category, a description, or more');
    expect(() => checkStatusSet({ description: 'Builds it', progress: 40 })).toThrow('progress goes with a summary');
    expect(() => checkStatusSet({ summary: 'Wiring', progress: 101 })).toThrow('progress must be a whole number from 0 to 100');
    expect(() => checkStatusSet({ summary: 'Done', agent: 'agent:1', done: true })).toThrow('done is for your own status');
  });
});

describe('a start with a prefab', () => {
  it('takes a chat only with a prefab, and nothing the prefab sets', () => {
    expect(checkPrefabStart('Ticket', 'lead', undefined)).toBe('lead');
    expect(checkPrefabStart(undefined, undefined, 'model')).toBeUndefined();
    expect(() => checkPrefabStart(undefined, 'lead', undefined)).toThrow('give a prefab too');
    expect(() => checkPrefabStart('Ticket', 'boss', undefined)).toThrow('chat is implementer or lead');
    expect(() => checkPrefabStart('Pair', undefined, 'model')).toThrow("model is the prefab's to set");
  });
});
