import { useEffect, useState } from 'react';
import type { Agent, PermissionDecision, PermissionPrompt } from '@agent-board/daemon/protocol';
import { Button } from '../ui';
import { useAction } from '../use-action';
import { permissionSentence, type PermissionSentence } from '../../../shared/permission-sentence';

/** How long a prompt that has just shown ignores clicks, so a second click meant for the last one can't answer it unread. */
const ARM_AFTER_MS = 400;

/** What deciding one permission prompt needs, wherever it shows: the pane's card and the Needs-you list alike. */
export interface PermissionDecisionState {
  call: PermissionSentence;
  busy: boolean;
  error: string | undefined;
  /** False for the first moment the prompt shows, while its buttons ignore clicks. */
  armed: boolean;
  decide(decision: PermissionDecision): void;
  /** Lets the harness ask now rather than when the hold lapses, then `then` shows where it asks. */
  review(then?: () => void): void;
}

/** The decision on one prompt of the agent's: it only relays a click, and never answers on its own. */
export function usePermissionDecision(agent: Agent, prompt: PermissionPrompt): PermissionDecisionState {
  const { busy, error, run } = useAction();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return {
    call: permissionSentence(prompt),
    busy,
    error,
    armed,
    decide: (decision) => run(() => window.agentBoard.agents.decidePermission(agent.sessionId, prompt.id, decision)),
    review: (then) => run(() => window.agentBoard.agents.releasePermission(agent.sessionId, prompt.id), then),
  };
}

/**
 * The buttons a permission prompt's TUI menu has, in its order: Deny, Allow for this session (only where the harness
 * suggested a rule to allow) and Allow once, the primary, trailing. A destructive call has Deny and Review… only, with
 * no Allow and no default; Review… is left out where there is nowhere to show the harness asking (`onReview`).
 * `compact`, for a list narrower than the pane's card, keeps Deny and Allow once together and puts Allow for this
 * session after them as a quiet button, so a long rule wraps on its own rather than pushing the primary under it.
 */
export function PermissionButtons({ agent, prompt, state, onReview, compact = false }: { agent: Agent; prompt: PermissionPrompt; state: PermissionDecisionState; onReview?(): void; compact?: boolean }) {
  const { call, busy, armed, decide, review } = state;
  const off = busy || !armed;
  const grant = prompt.sessionGrant !== null && (
    <Button
      size="sm"
      variant={compact ? 'ghost' : 'secondary'}
      className="pane-decision-grant"
      disabled={off}
      title={`Allow ${prompt.sessionGrant} for this session`}
      onClick={() => decide({ behavior: 'allow', scope: 'session' })}
    >
      Allow {prompt.sessionGrant} for this session
    </Button>
  );
  return (
    <>
      <Button size="sm" variant="danger" disabled={off} aria-label={`Deny ${prompt.toolName} for ${agent.name}`} onClick={() => decide({ behavior: 'deny' })}>
        Deny
      </Button>
      {call.destructive ? (
        onReview && (
          <Button size="sm" variant="primary" disabled={off} onClick={() => review(onReview)}>
            Review…
          </Button>
        )
      ) : (
        <>
          {!compact && grant}
          <Button size="sm" variant="primary" disabled={off} onClick={() => decide({ behavior: 'allow' })}>
            Allow once
          </Button>
          {compact && grant}
        </>
      )}
    </>
  );
}

/** `text` with its first letter lower-cased, to carry on a sentence; the rest, a tool's name or a path, is as it is. */
export const lowerFirst = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
