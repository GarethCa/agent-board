import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentAsk, AskAnswer } from '@agent-board/daemon/protocol';
import { useAction } from '../use-action';

/**
 * Answering an agent's question, wherever it shows (the needs-you inbox, its card on the board): the user's reply as
 * they type it, and the one way an answer goes, to the daemon by the question's id, so it never lands on another.
 * `pick` takes keys 1–9 for the options while the form has focus; digits typed into the reply field are words, and a
 * key already taken or held down picks nothing. While one answer is on its way, another isn't sent.
 */
export function useAskAnswer(sessionId: string, ask: AgentAsk) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const sending = useRef(false);
  const answer = (given: AskAnswer) => {
    if (sending.current) return;
    sending.current = true;
    run(
      () => window.agentBoard.asks.answer(sessionId, ask.id, given).finally(() => (sending.current = false)),
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== '') answer({ text });
  };
  const pick = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const option = Number(event.key) - 1;
    if (!Number.isInteger(option) || option < 0 || option >= ask.options.length) return;
    event.preventDefault();
    answer({ option });
  };
  return { text, setText, busy, error, answer, submit, pick };
}
