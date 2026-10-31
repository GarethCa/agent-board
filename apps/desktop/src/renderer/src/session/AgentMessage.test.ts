import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { MessageSender } from '@agent-board/daemon/protocol';
import { AgentMessage, HiddenAgents } from './AgentMessage';
import { ChatSettingContext, type ChatSetting } from './chat-parts';
import { ChatStream } from './ChatStreams';
import { chatItems } from './chat';

const captain: MessageSender = { ref: 'agent:944e1234', name: 'Captain', kind: 'send' };
const TRAILER = "\n\n[agent-board] From Captain (agent:944e1234), who you may answer with `agent-board send agent:944e1234 -- '…'`.";
const LONG = 'Review is back on PR 381. Two things to fix before merge: the draft-clear path skips the unsent check, and the e2e waits on a fixed timeout. Everything else looks good. Please rebase on main first, then push and tell me when the gate is green.';

const setting = (over: Partial<ChatSetting> = {}): ChatSetting => ({ style: 'cards', harness: 'claude', sessionId: 's', onOpenLink: () => {}, atWork: false, ...over });
const render = (node: ReturnType<typeof createElement>, over: Partial<ChatSetting> = {}) =>
  renderToStaticMarkup(createElement(ChatSettingContext.Provider, { value: setting(over) }, node));

describe("an agent's message in the chat", () => {
  test('is its own bubble with "From …" and the kind, never the user\'s block', () => {
    const html = render(createElement(AgentMessage, { text: 'Fix the login test', from: captain }));
    expect(html).toContain('data-testid="chat-agent-message"');
    expect(html).toContain('From Captain');
    expect(html).toContain('Message');
    expect(html).not.toContain('chat-user');
  });

  test("names a hand-off's payload and a reply as what they are", () => {
    expect(render(createElement(AgentMessage, { text: 'x', from: { ref: 'agent:1', name: 'impl', kind: 'hand-off', payload: 'plan.md' } }))).toContain('Hand-off · plan.md');
    expect(render(createElement(AgentMessage, { text: 'x', from: { ...captain, kind: 'reply' } }))).toContain('Reply');
  });

  test('keeps the trailer under its badge, out of the text', () => {
    const html = render(createElement(AgentMessage, { text: `Fix the login test${TRAILER}`, from: captain }));
    expect(html).toContain('data-testid="chat-agent-info"');
    expect(html).not.toContain('who you may answer with');
    expect(html).toContain('Fix the login test');
  });

  test('has no badge when the board added nothing', () => {
    expect(render(createElement(AgentMessage, { text: 'Fix it', from: captain }))).not.toContain('chat-agent-info');
  });

  test('folds past a few lines, with Show all; a short one does not', () => {
    const long = render(createElement(AgentMessage, { text: LONG, from: captain }));
    expect(long).toContain('Show all');
    const short = render(createElement(AgentMessage, { text: 'Short one', from: captain }));
    expect(short).not.toContain('Show all');
  });

  test("draws the Captain in its tricorn only where the chat dresses it, and a Codex agent as a block", () => {
    const look = (master: boolean, harness: 'claude' | 'codex') => () => ({ harness, master });
    const hat = render(createElement(AgentMessage, { text: 'x', from: captain }), { senderLook: look(true, 'claude'), captainHat: true });
    expect(hat).toContain('data-testid="captain"');
    expect(hat).toContain('data-sender="captain"');
    const plain = render(createElement(AgentMessage, { text: 'x', from: captain }), { senderLook: look(true, 'claude'), captainHat: false });
    expect(plain).not.toContain('data-testid="captain"');
    expect(plain).toContain('data-testid="sender-figure"');
    expect(plain).toContain('data-body="bean"');
    const codex = render(createElement(AgentMessage, { text: 'x', from: { ...captain, name: 'rev' } }), { senderLook: look(false, 'codex') });
    expect(codex).toContain('data-body="block"');
    expect(codex).toContain('data-sender="codex"');
  });
});

describe('the three chat styles draw the same bubble', () => {
  const items = chatItems([
    { kind: 'user', text: 'Mine' },
    { kind: 'user', text: `Theirs${TRAILER}`, from: captain },
  ]);
  for (const style of ['cards', 'timeline', 'status-line'] as const) {
    test(`as ${style}: one agent bubble beside the user's own block`, () => {
      const html = render(createElement(ChatStream, { items }), { style });
      expect(html.match(/data-testid="chat-agent-message"/g)).toHaveLength(1);
      expect(html.match(/data-testid="chat-user"/g)).toHaveLength(1);
    });
  }

  test('a hidden run is one line that can show them again', () => {
    expect(render(createElement(HiddenAgents, { count: 3 }))).toContain('3 agent messages hidden');
    expect(render(createElement(HiddenAgents, { count: 1 }))).toContain('1 agent message hidden');
  });
});
