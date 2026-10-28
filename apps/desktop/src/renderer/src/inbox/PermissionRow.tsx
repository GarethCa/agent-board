import { useState } from 'react';
import type { Agent, PermissionPrompt } from '@agent-board/daemon/protocol';
import { Button, ErrorText } from '../ui';
import { useAction } from '../use-action';
import { secondsLeft, toolSummary } from '../../../shared/needs-you';

/** A tool input longer than this, or on several lines, is clamped to one line with a Show all toggle. */
const CLAMP_AT = 60;

/**
 * One permission prompt of the agent's, with Allow and Deny while the daemon holds its hook. The tool input is clamped
 * to a line so the buttons stay in view, and opens in place; drawn by the inbox and the Captain's panel alike.
 */
export function PermissionRow({ agent, prompt, now }: { agent: Agent; prompt: PermissionPrompt; now: number }) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const decide = (behavior: 'allow' | 'deny') =>
    run(() => window.agentBoard.agents.decidePermission(agent.sessionId, prompt.id, { behavior }));
  const summary = toolSummary(prompt);
  const long = summary.length > CLAMP_AT || summary.includes('\n');
  return (
    <div className="inbox-prompt" data-testid="inbox-prompt" data-held={prompt.heldUntil !== null}>
      <p className="inbox-item-tool">
        {prompt.subagent ? `Its ${prompt.subagent.type} subagent wants` : 'Wants'} to use <strong>{prompt.toolName}</strong>
      </p>
      {summary && (
        <code className="inbox-item-input" data-testid="inbox-tool-input" data-open={open || undefined} title={summary}>
          {summary}
        </code>
      )}
      {long && (
        <Button size="sm" variant="ghost" className="inbox-item-expand" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </Button>
      )}
      {prompt.heldUntil !== null ? (
        <div className="inbox-item-actions">
          <span className="inbox-prompt-countdown" title="Then its terminal asks instead">
            {secondsLeft(prompt, now)} s
          </span>
          <Button size="sm" variant="danger" disabled={busy} aria-label={`Deny ${prompt.toolName} for ${agent.name}`} onClick={() => decide('deny')}>
            Deny
          </Button>
          <Button size="sm" variant="primary" disabled={busy} aria-label={`Allow ${prompt.toolName} for ${agent.name}`} onClick={() => decide('allow')}>
            Allow
          </Button>
        </div>
      ) : (
        <p className="inbox-item-note">Asking in its terminal now: open it to answer.</p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
