import { memo, useEffect, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentAsk } from '@agent-board/daemon/protocol';
import { Button, ErrorText, Input, Kbd } from '../ui';
import { useAskAnswer } from '../inbox/use-ask-answer';
import { useNow } from '../inbox/use-now';
import { askedAgo, questionNodeId, type QuestionNodeType } from './question-cards';
import { cardOption } from './question-card-keys';
import { useOnlySelected } from './items/items';

/**
 * A question card: an agent's question as a speech bubble beside its tile, in the waiting orange, its tail at the
 * tile until the user moves it (a tether joins them then). Each option is a button that answers in one click (keys
 * 1–9 while it has focus or is selected alone); with free text, a reply field and Send. It answers as the inbox does, and goes once
 * the question does, wherever it was answered.
 */
export const QuestionCardNode = memo(function QuestionCardNode({ data, selected }: NodeProps<QuestionNodeType>) {
  const only = useOnlySelected(selected);
  return <QuestionCard key={data.ask.id} sessionId={data.sessionId} name={data.name} ask={data.ask} side={data.side} selected={selected} only={only} />;
});

function QuestionCard(props: { sessionId: string; name: string; ask: AgentAsk; side: QuestionNodeType['data']['side']; selected: boolean; only: boolean }) {
  const { sessionId, name, ask, side, selected, only } = props;
  const { text, setText, busy, error, answer, submit } = useAskAnswer(sessionId, ask);
  const now = useNow(true);
  const answerRef = useRef(answer);
  answerRef.current = answer;
  // Keys 1–9 answer while the card itself has focus, or the board does with the card selected alone; never a key
  // something else took, so one press answers one question at most (`cardOption`).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape deselects the card; it lets go of focus too, so its keys stop answering it.
      if (event.key === 'Escape') {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest('.react-flow__node')?.getAttribute('data-id') === questionNodeId(sessionId)) active.blur();
        return;
      }
      const option = cardOption(event, document.activeElement, questionNodeId(sessionId), only, ask.options.length);
      if (option === undefined) return;
      event.preventDefault();
      answerRef.current({ option });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [only, sessionId, ask.options.length]);
  return (
    <form
      className="question-card"
      data-testid="question-card"
      data-session-id={sessionId}
      data-side={side ?? undefined}
      data-selected={selected || undefined}
      aria-label={`${name} asks`}
      onSubmit={submit}
    >
      <div className="question-card-head">
        <span className="question-card-name">{name}</span>
        <span>asks</span>
        <small className="question-card-age">{askedAgo(ask.askedAt, now)}</small>
      </div>
      <p className="question-card-question">{ask.question}</p>
      {ask.options.length > 0 && (
        <div className="question-card-options" role="group" aria-label={`Answers for ${name}`}>
          {ask.options.map((option, index) => (
            <Button
              key={index}
              size="sm"
              className="question-card-option nodrag"
              disabled={busy}
              aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
              onClick={() => answer({ option: index })}
            >
              {index < 9 && <Kbd aria-hidden>{index + 1}</Kbd>}
              <span className="question-card-option-text">{option}</span>
            </Button>
          ))}
        </div>
      )}
      {ask.freeText && (
        <div className="question-card-reply nodrag">
          <Input
            size="sm"
            aria-label={`Reply to ${name}`}
            placeholder={ask.options.length > 0 ? 'Or type an answer…' : 'Answer…'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={text.trim() === ''} aria-label={`Send to ${name}`}>
            Send
          </Button>
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {/* Where its tether starts once moved; never a connector's end. */}
      <Handle type="source" id="bottom" position={Position.Bottom} isConnectable={false} className="question-card-handle" />
    </form>
  );
}
