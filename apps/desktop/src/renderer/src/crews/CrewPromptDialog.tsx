import { Users } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { isOrchestratorRole, MAX_REVIEW_CAP, type LibraryPrefab, type Zone } from '@agent-board/daemon/protocol';
import { Button, Dialog, ErrorText, Field, Hint, Input, Kbd, Select, Tag, Textarea, Truncate } from '../ui';
import { ZoneName } from '../board/ZoneName';
import { keyText } from '../keys/registry';
import { useAction } from '../use-action';
import { bypassNoticeSeen, CodexBypassExplanation, markBypassNoticeSeen } from '../board/codex-notice';
import { useRecentFolders } from '../board/RecentFolders';
import { useTechnicalDetails } from '../technical';
import { RoleIcon } from './icons';
import { memberLabel, memberRun, promptMember } from './prefab-flow';
import { RepoField } from './RepoField';
import { crewStartBlock, needsRepo, takesTicket, ticketLookupHint, type StartBox } from './start-checks';

interface CrewPromptDialogProps {
  prefab: LibraryPrefab;
  /** The zones a crew can start in. */
  zones: readonly Zone[];
  /** The zone it starts in, named in its head. Without, it asks, starting on `suggested`. */
  zone: Zone | undefined;
  suggested?: Zone;
  /** No zone to start in: offered in its place. */
  onAddZone(): void;
  onStarted(sessionId: string): void;
  onCancel(): void;
  /** Drawn open in place, for the gallery. */
  inline?: boolean;
}

/**
 * The one prompt box a crew starts from, wherever it was picked: who is in the crew and when each starts, how many
 * rounds this crew runs (the prefab keeps its own), and the prompt, which its first member gets. Nothing runs until
 * Start crew, and only that first member starts then.
 */
export function CrewPromptDialog({ prefab, zones, zone: asked, suggested, onAddZone, onStarted, onCancel, inline = false }: CrewPromptDialogProps) {
  const technical = useTechnicalDetails();
  const [prompt, setPrompt] = useState('');
  const [issue, setIssue] = useState('');
  const [zoneId, setZoneId] = useState(asked?.id ?? suggested?.id ?? zones[0]?.id);
  const [roundLimit, setRoundLimit] = useState(prefab.roundLimit);
  const [repo, setRepo] = useState<string>();
  const { busy, error, run } = useAction();
  const zone = zones.find((each) => each.id === zoneId);
  const { folders = [] } = useRecentFolders((found) => setRepo((current) => current ?? found[0]?.path));
  const repoWanted = needsRepo(zone);
  const looping = prefab.members.length > 1;
  const first = promptMember(prefab);
  // A prefab drafted with a ticket input asks for its ticket, which may stand in for the prompt.
  const ticketWanted = takesTicket(prefab);
  const blocked = crewStartBlock({ zones, zone, repo: repoWanted ? repo : undefined, prompt, ticket: ticketWanted ? issue : undefined });
  const ready = blocked === undefined && zone !== undefined;
  /** Why Start is greyed, said next to the box that holds it back. */
  const why = (box: StartBox) => blocked?.box === box && <Hint data-testid="start-blocked">{blocked.reason}</Hint>;
  const lookup = ticketWanted ? ticketLookupHint(zones, issue) : undefined;

  const led = first !== undefined && isOrchestratorRole(first.role);
  /** One start at a time, however fast ⌘↵ is pressed: two would start two crews. */
  const starting = useRef(false);
  const [notice, setNotice] = useState(false);
  const start = (noticeShown = false) => {
    if (!ready || starting.current) return;
    starting.current = true;
    run(
      () =>
        window.agentBoard.orchestrators
          .startPrefab({
            name: prefab.name,
            ...(prompt.trim() === '' ? {} : { prompt: prompt.trim() }),
            zoneId: zone.id,
            ...(ticketWanted && issue.trim() !== '' ? { issueId: issue.trim() } : {}),
            ...(repoWanted && repo !== undefined ? { repo } : {}),
            ...(roundLimit === prefab.roundLimit ? {} : { roundLimit }),
          })
          .finally(() => {
            starting.current = false;
          }),
      (started) => {
        if (noticeShown) markBypassNoticeSeen();
        onStarted(started.started[0]!.sessionId);
      },
    );
  };
  // A start under way can't be called back, and leaving would look as if nothing had started: it stays until it is done.
  const leave = () => {
    if (!busy) onCancel();
  };
  const submitOnKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  /** As New agent does: before the first Codex agent that would skip hook review, it says so, and Back is still there. */
  const submit = () => {
    if (!ready || busy) return;
    const codex = prefab.members.some((member) => member.harness === 'codex') && zone.codexBypassHookTrust !== false;
    if (codex && !bypassNoticeSeen()) setNotice(true);
    else start();
  };

  if (notice) {
    return (
      <Dialog
        aria-label="About Codex hooks"
        title="Codex agents skip hook review"
        onClose={leave}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNotice(false)}>
              Back
            </Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                setNotice(false);
                start(true);
              }}
            >
              {looping ? 'Start crew' : 'Start'}
            </Button>
          </>
        }
      >
        <CodexBypassExplanation />
      </Dialog>
    );
  }

  return (
    <Dialog
      aria-label="Start a crew"
      title={
        <span className="crew-prompt-title">
          <span className="prefab-mark" aria-hidden>
            <Users />
          </span>
          <span>
            {prefab.name}
            {asked !== undefined && ' in '}
            {asked !== undefined && <ZoneName name={asked.name} />}
          </span>
        </span>
      }
      onClose={leave}
      inline={inline}
      data-testid="crew-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      footerStart={
        looping ? (
          <label className="crew-prompt-rounds" onKeyDown={submitOnKey}>
            {led ? 'Lead stops after' : 'Stop after'}
            <Select aria-label="Round limit" size="sm" value={roundLimit} onChange={(event) => setRoundLimit(Number(event.target.value))}>
              {Array.from({ length: MAX_REVIEW_CAP }, (_, n) => n + 1).map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'round' : 'rounds'}
                </option>
              ))}
            </Select>
          </label>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={leave}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            {looping ? 'Start crew' : 'Start'}
            <Kbd aria-hidden>{keyText('dialog.submit')}</Kbd>
          </Button>
        </>
      }
    >
      <div className="crew-prompt" onKeyDown={submitOnKey}>
        {zones.length === 0 && (
          <div className="crew-prompt-no-zone">
            <Hint>A crew starts in a zone, and the board has none yet.</Hint>
            <Button autoFocus onClick={onAddZone}>
              Add a zone
            </Button>
          </div>
        )}
        {asked === undefined && zones.length > 0 && (
          <Field label="Zone">
            <Select aria-label="Zone" value={zoneId ?? ''} onChange={(event) => setZoneId(event.target.value)}>
              {zones.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {zones.length > 0 && why('zone')}
        {repoWanted && <RepoField repo={repo} folders={folders} onRepo={setRepo} browseTitle="Choose the repo for this crew" />}
        {why('repo')}
        {ticketWanted && (
          <Field label="Ticket">
            <Input aria-label="Ticket" placeholder="Its issue or its link, such as ABC-12" value={issue} disabled={zones.length === 0} onChange={(event) => setIssue(event.target.value)} />
          </Field>
        )}
        {lookup !== undefined && <Hint>{lookup}</Hint>}
        <Textarea
          aria-label="Prompt"
          rows={4}
          // With no zone there is nothing to start: a prompt typed now would be lost on the way to adding one.
          autoFocus={zones.length > 0}
          disabled={zones.length === 0}
          placeholder={looping ? 'What should the crew do?' : 'What should it do?'}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {zones.length > 0 && why('work')}
        {looping && first !== undefined && (
          <Hint>
            {led
              ? `One prompt for the crew. ${memberLabel(first)} gets it, and starts the others when it has work for them.`
              : `One prompt for the crew. ${memberLabel(first)} gets it; the others get ${memberLabel(first)}'s work.`}
          </Hint>
        )}
        <ul className="crew-prompt-members" aria-label="Who is in the crew">
          {prefab.members.map((member) => {
            const { does, detail, when } = memberRun(member, prefab, technical);
            return (
              <li key={member.id} className="crew-prompt-member">
                <span className="prefab-node-bubble small" aria-hidden>
                  <RoleIcon member={member} />
                </span>
                <span className="crew-prompt-member-text">
                  <span>
                    <b>{memberLabel(member)}</b> {does}
                  </span>
                  <span className="crew-prompt-member-detail">{detail}</span>
                </span>
                <Tag title={when}>
                  <Truncate text={when} title={null} />
                </Tag>
              </li>
            );
          })}
        </ul>
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Dialog>
  );
}
