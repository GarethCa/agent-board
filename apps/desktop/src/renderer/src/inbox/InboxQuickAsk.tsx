// An ask of several questions in Needs you: the quick ask itself, as on the agent's tile, stepped through in its row.
// It takes no focus as it shows, as a list of rows never does; a click or Tab puts the keys in it.
import { useRef, useState } from 'react';
import type { Agent, AgentAsk } from '@agent-board/daemon/protocol';
import { ErrorText } from '../ui';
import { QuickAsk, type QuickAskDrafts } from '../board/QuickAsk';
import { firstOpen } from '../board/quick-ask';
import { useQuickAskActions } from '../board/TileQuickAsk';

export function InboxQuickAsk({ agent, ask }: { agent: Agent; ask: AgentAsk }) {
  const [at, setAt] = useState(() => firstOpen(ask));
  const { actions, error, busy } = useQuickAskActions(agent.sessionId, ask.id);
  // Keyed by its ask where it is drawn, so what is typed lasts as long as the ask does.
  const drafts = useRef<QuickAskDrafts>(new Map()).current;
  return (
    <div className="inbox-quick-ask" data-testid="inbox-quick-ask">
      <QuickAsk name={agent.name} ask={ask} at={Math.min(at, ask.questions.length)} onAt={setAt} actions={actions} busy={busy} drafts={drafts} still />
      {error !== undefined && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
