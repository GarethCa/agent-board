// A steps card an agent waits on, as Needs you and its window show it: a set to answer, stepped through in place, or a
// to-do of the user's, ticked in place. The card's data is read live, as any window has the board's items.
import { createContext, use, useEffect, useMemo, useState } from 'react';
import { Check, Circle, ListTodo } from 'lucide-react';
import type { Agent, AgentStepsWait, BoardItem, StepsData } from '@agent-board/daemon/protocol';
import { Button, ErrorText } from '../ui';
import { useAction } from '../use-action';
import { StepsStepper, type StepsCardActions } from '../board/items/StepsCard';
import type { StepsLookup } from '../board/items/steps-view';
import { stepsLeftWords } from '../../../shared/needs-you';

/** Cards given by id instead of read from the board: for the gallery, whose rows name cards no board holds. */
export const GivenStepsCards = createContext<Readonly<Record<string, StepsData>>>({});

/** The steps card `itemId` as it is now, from the board's items and their changes; undefined until read, or once gone. */
function useStepsCard(itemId: string): StepsData | undefined {
  const given = use(GivenStepsCards)[itemId];
  const [data, setData] = useState<StepsData>();
  useEffect(() => {
    let current = true;
    // A change heard before the list arrives is newer than the list: the list doesn't put it back.
    let changed = false;
    const items = window.agentBoard.items;
    const of = (item: BoardItem) => item.data as unknown as StepsData;
    void items.list().then((all) => {
      const found = all.find((item) => item.id === itemId);
      if (current && !changed) setData(found === undefined ? undefined : of(found));
    });
    const stop = items.onChanged((change) => {
      const mine = (change.type === 'item.updated' && change.item.id === itemId) || (change.type === 'item.removed' && change.id === itemId);
      if (!mine) return;
      changed = true;
      setData(change.type === 'item.updated' ? of(change.item) : undefined);
    });
    return () => {
      current = false;
      stop();
    };
  }, [itemId]);
  return given ?? data;
}

/** The user's answers, ticks and Send on the card `itemId`, as on the card itself. */
function useStepsActions(itemId: string): { actions: StepsCardActions; error: string | undefined; busy: boolean } {
  const { error, run, busy } = useAction();
  const actions = useMemo<StepsCardActions>(() => {
    const asks = () => window.agentBoard.asks;
    return {
      answer: (stepId, answer) => run(() => asks().answerStep(itemId, stepId, answer)),
      tick: (stepId, done) => run(() => asks().tickStep(itemId, stepId, done)),
      send: () => run(() => asks().sendSteps(itemId)),
      stepIn: () => {},
      leave: () => {},
    };
  }, [run, itemId]);
  return { actions, error, busy };
}

/** Names the agents a stepper mentions: every one live, by the name the board lists. */
const lookupOf = (agents: readonly Pick<Agent, 'sessionId' | 'name' | 'endedAt'>[]): StepsLookup => ({
  live: (sessionId) => agents.some((agent) => agent.sessionId === sessionId && agent.endedAt === null),
  name: (sessionId) => agents.find((agent) => agent.sessionId === sessionId)?.name,
});

/**
 * The body of a Steps or To-do row, one icon-led line: what the card asks, then Answer, which opens its questions in
 * place (`open` to start so, as the agent's own window does), or Done, which ticks the to-do. Open, the stepper is
 * all there is: its head names the set.
 */
export function StepsWaitBody({ wait, agents, open = false, onOpen }: { wait: AgentStepsWait; agents: readonly Agent[]; open?: boolean; onOpen?(): void }) {
  const [answering, setAnswering] = useState(open);
  // Opened by Answer, it takes the keys at once, as the quick ask does; open by itself (the strip), it waits for a click.
  const [asked, setAsked] = useState(false);
  const data = useStepsCard(wait.itemId);
  const { actions, error, busy } = useStepsActions(wait.itemId);
  // Worked out again only when who the agents are, or whether they are live, changes: not for every new list.
  const names = agents.map((agent) => `${agent.sessionId}:${agent.name}:${agent.endedAt ?? ''}`).join('\n');
  // `names` is all of `agents` that the lookup reads.
  const lookup = useMemo(() => lookupOf(agents), [names]);
  if (wait.kind === 'steps' && answering && data !== undefined) {
    return (
      <div className="steps-wait" data-testid="steps-wait" data-kind="steps" data-open>
        <StepsStepper data={data} lookup={lookup} actions={actions} busy={busy} focus={asked} error={error} />
      </div>
    );
  }
  const todo = wait.kind === 'todo';
  return (
    <div className="steps-wait" data-testid="steps-wait" data-kind={wait.kind}>
      <div className="steps-wait-line">
        <span className="steps-wait-icon" aria-hidden>
          {todo ? <Circle /> : <ListTodo />}
        </span>
        <span className="steps-wait-words">
          <span className="steps-wait-text">{todo ? wait.text : stepsLeftWords(wait)}</span>
          <span className="steps-wait-on">on “{wait.title}”</span>
        </span>
        {onOpen !== undefined && (
          <Button size="sm" variant="ghost" onClick={onOpen}>
            Open
          </Button>
        )}
        {todo ? (
          <Button size="sm" className="steps-wait-go" icon={<Check />} disabled={busy} onClick={() => actions.tick(wait.stepId, true)}>
            Done
          </Button>
        ) : (
          // Until its card is read, there is nothing to step through.
          <Button size="sm" className="steps-wait-go" icon={<ListTodo />} loading={data === undefined} onClick={() => {
              setAsked(true);
              setAnswering(true);
            }}
            data-testid="steps-wait-answer"
          >
            Answer
          </Button>
        )}
      </div>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
