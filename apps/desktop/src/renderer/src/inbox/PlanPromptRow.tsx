// Claude's plan approval (its plan tool's permission prompt) in Needs you, the Captain's panel and the Simplified pane,
// in Claude's own words (P1). Each button answers its held hook as the same choice in Claude's dialog would.
import { useState } from 'react';
import type { Agent, PermissionPrompt } from '@agent-board/daemon/protocol';
import { Button, ErrorText } from '../ui';
import { Markdown } from '../session/Markdown';
import { keepPlanning, PLAN_CHOICES, planGlimpse, planTitle } from '../../../shared/claude-plan';
import { usePermissionDecision } from './permission-decision';

const openLink = (url: string) => void window.agentBoard.trackers.openLink(url).catch(() => undefined);

/**
 * "‹agent› has a plan for you": its title and first lines, Read the plan to show it all, read only, and Claude's
 * choices. No, keep planning… opens a field for what to change. `onOpen` opens the agent, where its terminal has the
 * choices the hook can't give.
 */
export function PlanPromptRow({ agent, prompt, plan, onOpen }: { agent: Agent; prompt: PermissionPrompt; plan: string; onOpen?(): void }) {
  const state = usePermissionDecision(agent, prompt);
  const { busy, armed, decide, error } = state;
  const off = busy || !armed;
  const [all, setAll] = useState(false);
  const [changing, setChanging] = useState(false);
  const [words, setWords] = useState('');
  const title = planTitle(plan);
  const glimpse = planGlimpse(plan);
  return (
    <div className="inbox-prompt inbox-plan" data-testid="inbox-plan" data-held={prompt.heldUntil !== null}>
      <p className="inbox-row-what">
        {prompt.subagent ? `Its ${prompt.subagent.type} subagent has a plan for you` : `${agent.name} has a plan for you`}
      </p>
      <div className="inbox-plan-text" data-testid="inbox-plan-text" data-open={all || undefined}>
        {all ? (
          <Markdown text={plan} onOpenLink={openLink} />
        ) : (
          <>
            {title !== '' && <p className="inbox-plan-title">{title}</p>}
            {glimpse !== '' && <Markdown text={glimpse} onOpenLink={openLink} />}
          </>
        )}
      </div>
      <Button size="sm" variant="ghost" className="inbox-item-expand" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? 'Show less' : 'Read the plan'}
      </Button>
      {prompt.heldUntil === null ? (
        <p className="inbox-item-note">Asking in its terminal now: open it to answer.</p>
      ) : changing ? (
        <>
          <textarea
            className="inbox-plan-change"
            aria-label="What to change"
            placeholder="What to change"
            rows={2}
            autoFocus
            value={words}
            onChange={(event) => setWords(event.target.value)}
          />
          <div className="inbox-item-actions">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setChanging(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => decide(keepPlanning(words))}>
              Keep planning
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="inbox-item-actions">
            {PLAN_CHOICES.map((choice) => (
              <Button key={choice.label} size="sm" variant={choice.primary ? 'primary' : 'secondary'} disabled={off} onClick={() => decide(choice.decision)}>
                {choice.label}
              </Button>
            ))}
            <Button size="sm" variant="secondary" disabled={off} onClick={() => setChanging(true)}>
              No, keep planning…
            </Button>
          </div>
          <p className="quick-ask-where" data-testid="plan-where">
            Clear context or bypass permissions:{' '}
            {onOpen !== undefined ? (
              <button type="button" className="quick-ask-link" onClick={onOpen}>
                in its terminal
              </button>
            ) : (
              'in its terminal'
            )}
          </p>
        </>
      )}
      {error !== undefined && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
