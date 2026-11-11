import type { ReactNode } from 'react';
import { Repeat } from 'lucide-react';
import { Button, ErrorText, StatusPill } from '../../ui';
import { PrefabIcon, RoleIcon } from '../../crews/icons';
import { PullRequestChip } from '../HybridTile';
import { StatusMark } from '../StatusMark';
import type { CrewAction, CrewCardModel, CrewRow } from './crew-card';

export interface CrewCardViewProps {
  /** What its crew was asked, in a line. */
  title: string;
  /** Its prefab's icon. */
  icon: string;
  model: CrewCardModel;
  /** The action being carried out, whose button waits. */
  busy?: CrewAction['id'];
  /** Why its last action was refused: said in place of what its model has gone wrong. */
  error?: string;
  onAction(action: CrewAction): void;
  /** Opens a member's agent, from its row. */
  onOpenAgent(sessionId: string): void;
  /** Opens its builder's pull request, from its chip. */
  onOpenPullRequest(): void;
  /** Its toolbar, on the board. */
  children?: ReactNode;
}

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

function Row({ row, onOpen }: { row: CrewRow; onOpen(sessionId: string): void }) {
  const said = `${row.name}${row.detail === '' ? '' : ` · ${row.detail}`}`;
  const body = (
    <>
      <span className="crew-face" aria-hidden>
        <RoleIcon member={row.member} />
      </span>
      {row.status === undefined ? <StatusPill state={row.pill.state} label={row.pill.label} data-mark={row.mark} /> : <StatusMark status={row.status} />}
      <span className="crew-card-row-text" title={said}>
        <span className="crew-card-row-name">{row.name}</span>
        {row.detail !== '' && <span className="crew-card-row-detail"> · {row.detail}</span>}
      </span>
    </>
  );
  const { sessionId } = row;
  return (
    <li className="crew-card-row" data-testid="crew-card-row" data-member={row.member.id}>
      {sessionId === undefined ? (
        <span className="crew-card-row-body">{body}</span>
      ) : (
        <button type="button" className="crew-card-row-body nodrag" aria-label={`Open ${row.name}: ${row.pill.label}`} onClick={() => onOpen(sessionId)}>
          {body}
        </button>
      )}
    </li>
  );
}

/**
 * A running crew's card (`CrewCardModel`): what it was asked, its rounds, a row for each member, and below them its last
 * hand-off while it runs, or where it stopped with what the user can do there. Its builder's pull request, with its
 * checks, is on it at every look that has one. It only shows and asks: each button is the user's own step, and nothing
 * on it approves or merges.
 */
export function CrewCardView({ title, icon, model, busy, error, onAction, onOpenAgent, onOpenPullRequest, children }: CrewCardViewProps) {
  const { pullRequest } = model;
  const chip = pullRequest !== undefined && <PullRequestChip pr={pullRequest.pr} open={onOpenPullRequest} />;
  const wrong = error ?? model.error;
  return (
    <div className="crew-card" data-testid="crew-card" data-tone={model.tone} onDoubleClick={(event) => event.stopPropagation()}>
      {children}
      <div className="crew-card-head">
        <span className="crew-face crew-card-icon" aria-hidden>
          <PrefabIcon icon={icon} />
        </span>
        <b className="crew-card-title" title={title}>
          {title}
        </b>
      </div>
      <div className="crew-card-loop">
        <Repeat aria-hidden />
        {model.rounds.length > 0 && (
          <span className="crew-card-rounds" aria-hidden>
            {model.rounds.map((chip) => (
              <i key={chip.round} data-state={chip.state}>
                R{chip.round}
              </i>
            ))}
          </span>
        )}
        <span data-testid="crew-card-round">{model.roundText}</span>
      </div>
      <ul className="crew-card-rows nowheel">
        {model.rows.map((row) => (
          <Row key={row.member.id} row={row} onOpen={onOpenAgent} />
        ))}
      </ul>
      {model.label === null ? (
        <div className="crew-card-end">
          {model.last !== null && (
            <p className="crew-card-last" data-testid="crew-card-last">
              <span aria-hidden>↳ </span>
              {model.last}
            </p>
          )}
          <div className="crew-card-foot">
            {chip}
            <span>{plural(model.agents, 'agent')} on the board</span>
          </div>
        </div>
      ) : (
        <div className="crew-card-end">
          <p className="crew-card-why" data-testid="crew-card-why" title={model.why ?? undefined}>
            <span className="crew-card-label" data-testid="crew-card-label">
              {model.label}
            </span>{' '}
            {model.why}
          </p>
          {wrong !== null && (
            <ErrorText className="crew-card-error">
              <span title={wrong}>{wrong}</span>
            </ErrorText>
          )}
          {(model.actions.length > 0 || pullRequest !== undefined) && (
            <div className="crew-card-actions">
              {model.actions.map((action) => (
                <Button
                  key={action.id}
                  size="xs"
                  variant={action.primary ? 'primary' : 'secondary'}
                  className="nodrag"
                  loading={busy === action.id}
                  disabled={busy !== undefined}
                  onClick={() => onAction(action)}
                >
                  {action.label}
                </Button>
              ))}
              {chip}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
