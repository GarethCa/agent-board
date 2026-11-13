import { useState } from 'react';
import type { Agent, PermissionPrompt, PromptQuestion } from '@agent-board/daemon/protocol';
import { Clock, SquareArrowOutUpRight } from 'lucide-react';
import { Button, ErrorText } from '../ui';
import { useAction } from '../use-action';
import { useSimplified } from '../design';
import { permissionWaitLine, secondsLeft, toolSummary } from '../../../shared/needs-you';
import { PermissionButtons, lowerFirst, usePermissionDecision } from './permission-decision';
import { DialogQuickAsk } from '../board/DialogQuickAsk';
import { dialogStatus, isDialogPrompt } from '../board/quick-ask';
import { PlanPromptRow } from './PlanPromptRow';

/** A tool input longer than this, or on several lines, is clamped to one line with a Show all toggle. */
const CLAMP_AT = 60;

interface PermissionRowProps {
  agent: Agent;
  prompt: PermissionPrompt;
  now: number;
  /** Shows the agent, where the harness asks once Review… lets it; without it a destructive call has Deny alone. */
  onReview?(): void;
  /** Opens the agent's window, where Claude's question dialog takes the answers; `onReview` where this isn't given. */
  onOpen?(): void;
}

/**
 * One permission prompt of the agent's, with Allow and Deny while the daemon holds its hook, counting down to the
 * terminal taking over where the terminal waits on the hold (not where it asks at the same time, as Claude does). The tool input is clamped
 * to a line so the buttons stay in view, and opens in place; drawn by the inbox and the Captain's panel alike. Under
 * the Simplified design it reads as the pane's card does (`SimplifiedPermissionRow`).
 */
export function PermissionRow(props: PermissionRowProps) {
  const simplified = useSimplified();
  const { agent, prompt } = props;
  const open = props.onOpen ?? props.onReview;
  // Claude's question dialog: answered here while the board can, else read only (a subagent's, or unreadable).
  if (isDialogPrompt(prompt) && dialogStatus(prompt) !== 'terminal') return <DialogQuickAsk sessionId={agent.sessionId} name={agent.name} prompt={prompt} onOpen={open} />;
  if (prompt.questions !== null) return <QuestionsRow agent={agent} questions={prompt.questions} onOpen={open} />;
  if (prompt.plan !== null) return <PlanPromptRow agent={agent} prompt={prompt} plan={prompt.plan} onOpen={open} />;
  return simplified ? <SimplifiedPermissionRow {...props} /> : <ClassicPermissionRow {...props} />;
}

/**
 * Claude's question tool's call the board can't answer, under either design: its questions, each with its options and
 * the "Other" answer the dialog always offers, to read. Only the agent's own dialog answers them (a subagent's, one
 * whose questions can't all be read, or its hold over), so the row has no Allow: it opens the agent.
 */
function QuestionsRow({ agent, questions, onOpen }: { agent: Agent; questions: PromptQuestion[]; onOpen?(): void }) {
  return (
    <div className="inbox-prompt inbox-questions" data-testid="inbox-questions">
      {questions.map(({ question, header, options, multiSelect }, index) => (
        <div key={index} className="inbox-question" data-testid="inbox-question">
          <p className="inbox-ask-question">
            {header !== '' && <span className="inbox-question-header">{header}</span>}
            {question}
          </p>
          <ul className="inbox-question-options" aria-label={multiSelect ? 'Its options: pick any' : 'Its options: pick one'}>
            {options.map((option) => (
              <li key={option.label} data-testid="inbox-question-option" title={option.description || undefined}>
                {option.label}
              </li>
            ))}
            <li className="inbox-question-other">Other: in your own words</li>
          </ul>
        </div>
      ))}
      <div className="inbox-item-actions">
        {onOpen !== undefined ? (
          <Button size="sm" variant="primary" icon={<SquareArrowOutUpRight />} aria-label={`Open ${agent.name} to answer its questions`} onClick={onOpen}>
            Open the agent to answer
          </Button>
        ) : (
          <p className="inbox-item-note">Open the agent to answer its questions.</p>
        )}
      </div>
    </div>
  );
}

function ClassicPermissionRow({ agent, prompt, now }: PermissionRowProps) {
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
          {!prompt.asksInTerminal && (
            <span className="inbox-prompt-countdown" title="Then its terminal asks instead">
              {secondsLeft(prompt, now)} s
            </span>
          )}
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

/**
 * The Simplified design's row for a prompt: the plain sentence from the pane's table, what it acts on in mono, clamped
 * to a line with Show command to open it, and the pane's own buttons (`PermissionButtons`), with one timer line under
 * them. A destructive call has Deny and Review… only. Return never answers it: every button needs a click, or Tab and
 * Space.
 */
function SimplifiedPermissionRow({ agent, prompt, now, onReview }: PermissionRowProps) {
  const state = usePermissionDecision(agent, prompt);
  const [open, setOpen] = useState(false);
  const { call, error } = state;
  const long = call.detail.length > CLAMP_AT || call.detail.includes('\n');
  const who = prompt.subagent ? `Its ${prompt.subagent.type} subagent asks` : 'Asks';
  return (
    <div className="inbox-prompt" data-testid="inbox-prompt" data-held={prompt.heldUntil !== null} data-destructive={call.destructive || undefined}>
      <p className="inbox-row-what" data-testid="inbox-permission-sentence">
        {who} permission to {lowerFirst(call.sentence)}
        {call.detail === '' ? '.' : call.sentence.includes(':') ? '' : ':'}
      </p>
      {call.detail !== '' && (
        <code className="inbox-item-input" data-testid="inbox-tool-input" data-open={open || undefined} title={call.detail}>
          {call.detail}
        </code>
      )}
      {prompt.heldUntil !== null ? (
        <>
          <div className="inbox-item-actions">
            <PermissionButtons agent={agent} prompt={prompt} state={state} onReview={onReview} compact />
            {long && (
              <Button size="sm" variant="ghost" className="inbox-item-expand" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? 'Show less' : 'Show command'}
              </Button>
            )}
          </div>
          {call.destructive && (
            <p className="inbox-row-warning" data-testid="permission-warning">
              This can’t be undone.
            </p>
          )}
          <p className="inbox-row-meta" data-testid="permission-wait">
            {/* The clock only where the line counts down: a prompt its terminal asks too has no time on it. */}
            {!prompt.asksInTerminal && secondsLeft(prompt, now) > 0 && <Clock aria-hidden />}
            {permissionWaitLine(prompt, agent.name, now)}
          </p>
        </>
      ) : (
        <p className="inbox-item-note">Asking in its terminal now: open it to answer.</p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
