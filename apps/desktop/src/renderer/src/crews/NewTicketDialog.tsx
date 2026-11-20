import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Hammer, MessagesSquare, PenLine, Search, Ticket } from 'lucide-react';
import { DEFAULT_TICKET_CHAT_KIND, type LibraryPrefab, type TicketChatKind, type Zone } from '@agent-board/daemon/protocol';
import { Button, Choice, Choices, Dialog, ErrorText, Field, Fieldset, Hint, Input, Kbd, Select, Textarea } from '../ui';
import { ZoneName } from '../board/ZoneName';
import { keyText } from '../keys/registry';
import { useAction } from '../use-action';
import type { HelperKind } from '../board/ticket-tile';
import { sheetStart, ticketPresets } from './ticket-sheet';

const HELPER_ICONS: Record<HelperKind, ReactNode> = {
  design: <PenLine aria-hidden />,
  build: <Hammer aria-hidden />,
  review: <Search aria-hidden />,
};

interface NewTicketDialogProps {
  /** The library: its prefabs that start inside a ticket tile are the sheet's helper presets. */
  prefabs: readonly LibraryPrefab[];
  /** The preset it starts on: a ticket prefab picked by name, else the first. */
  prefab?: string;
  zones: readonly Zone[];
  /** The zone it starts in. Without, it asks, starting on `suggested`. */
  zone: Zone | undefined;
  suggested?: Zone;
  onAddZone(): void;
  onStarted(sessionId: string): void;
  onCancel(): void;
  /** Drawn open in place, for the gallery. */
  inline?: boolean;
}

/**
 * New ▸ Ticket: one ticket tile, started from a ticket prefab. Its ticket and prompt, who builds it (its chat, as the
 * implementer, or its own lead with a builder helper: the implementer, or the prefab's choice, until changed here), and its helpers, picked
 * from the ticket prefabs. Nothing runs until Start ticket, and only the chat starts then.
 */
export function NewTicketDialog({ prefabs, prefab: asked, zones, zone: inZone, suggested, onAddZone, onStarted, onCancel, inline = false }: NewTicketDialogProps) {
  const ownPresets = ticketPresets(prefabs, (each) => each.ticketChat ?? DEFAULT_TICKET_CHAT_KIND);
  const [start] = useState(() => sheetStart(ownPresets, asked));
  const [name, setName] = useState(start.name);
  const [kind, setKind] = useState<TicketChatKind>(start.kind);
  /** A kind picked here by hand, which a preset picked after keeps. */
  const [kindPicked, setKindPicked] = useState(false);
  const pickKind = (picked: TicketChatKind) => {
    setKind(picked);
    setKindPicked(true);
  };
  const preset = ownPresets.find((each) => each.name === name);
  const presets = ticketPresets(prefabs, () => kind);
  const [issue, setIssue] = useState('');
  const [prompt, setPrompt] = useState('');
  const [zoneId, setZoneId] = useState(inZone?.id ?? suggested?.id ?? zones[0]?.id);
  const zone = zones.find((each) => each.id === zoneId);
  const noRepo = zone !== undefined && zone.repoRoot === null && zone.defaultRepo === null;
  const { busy, error, run } = useAction();
  const ready = preset !== undefined && zone !== undefined && !noRepo && (issue.trim() !== '' || prompt.trim() !== '');
  /** One start at a time, however fast ⌘↵ is pressed: two would start two tickets. */
  const starting = useRef(false);

  const submit = () => {
    if (!ready || busy || starting.current) return;
    starting.current = true;
    run(
      () =>
        window.agentBoard.orchestrators
          .startPrefab({
            name: preset.name,
            ...(prompt.trim() === '' ? {} : { prompt: prompt.trim() }),
            zoneId: zone.id,
            ...(issue.trim() === '' ? {} : { issueId: issue.trim() }),
            ...(kind === preset.ticketChat ? {} : { ticketChat: kind }),
          })
          .finally(() => {
            starting.current = false;
          }),
      (started) => onStarted(started.started[0]!.sessionId),
    );
  };
  const leave = () => {
    if (!busy) onCancel();
  };
  const submitOnKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Dialog
      aria-label="New ticket"
      title={
        <span className="crew-prompt-title">
          <span className="prefab-mark" aria-hidden>
            <Ticket />
          </span>
          <span>
            New ticket
            {inZone !== undefined && ' in '}
            {inZone !== undefined && <ZoneName name={inZone.name} />}
          </span>
        </span>
      }
      onClose={leave}
      inline={inline}
      data-testid="new-ticket"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={leave}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            Start ticket
            <Kbd aria-hidden>{keyText('dialog.submit')}</Kbd>
          </Button>
        </>
      }
    >
      <div className="crew-prompt new-ticket" onKeyDown={submitOnKey}>
        {zones.length === 0 && (
          <div className="crew-prompt-no-zone">
            <Hint>A ticket starts in a zone, and the board has none yet.</Hint>
            <Button autoFocus onClick={onAddZone}>
              Add a zone
            </Button>
          </div>
        )}
        {(inZone === undefined || noRepo) && zones.length > 0 && (
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
        {noRepo && <Hint>A ticket works on a branch: start it in a zone with a repo.</Hint>}
        <Field label="Ticket">
          <Input aria-label="Ticket" placeholder="Its issue, such as ABC-12" value={issue} autoFocus={zones.length > 0} onChange={(event) => setIssue(event.target.value)} />
        </Field>
        <Textarea aria-label="Prompt" rows={3} placeholder="What should it do? Its issue says, if you leave this empty." value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <Fieldset legend="Ticket chat">
          <Choices aria-label="Ticket chat">
            <Choice
              name="ticket-chat"
              mark={
                <span className="new-ticket-helpers" aria-hidden>
                  <MessagesSquare />
                </span>
              }
              label="Its own lead"
              detail="Talks to you and starts a builder. One more session."
              checked={kind === 'lead'}
              onChange={() => pickKind('lead')}
            />
            <Choice
              name="ticket-chat"
              mark={
                <span className="new-ticket-helpers new-ticket-builds" aria-hidden>
                  <Hammer />
                </span>
              }
              label="The implementer"
              detail="Talks to you and builds. One session fewer."
              checked={kind === 'implementer'}
              onChange={() => pickKind('implementer')}
            />
          </Choices>
        </Fieldset>
        <Fieldset legend="Helpers">
          <div className="new-ticket-presets" role="radiogroup" aria-label="Helpers">
            {presets.map((each) => (
              <Choice
                key={each.name}
                name="ticket-helpers"
                className="new-ticket-preset"
                data-testid="ticket-preset"
                mark={
                  <span className="new-ticket-helpers" aria-hidden>
                    {each.kinds.length === 0 ? <Ticket /> : each.kinds.map((helper, at) => <span key={at}>{HELPER_ICONS[helper]}</span>)}
                  </span>
                }
                label={
                  <>
                    {each.label}
                    {each.chatBuilds && each.kinds.length > 0 && <span className="new-ticket-builds"> · the chat builds</span>}
                  </>
                }
                detail={each.detail}
                checked={each.name === name}
                onChange={() => {
                  // A prefab presets who builds, its own kind of chat, unless one was picked here.
                  setName(each.name);
                  if (!kindPicked) setKind(ownPresets.find((own) => own.name === each.name)?.ticketChat ?? DEFAULT_TICKET_CHAT_KIND);
                }}
              />
            ))}
          </div>
          {presets.length === 0 && <Hint>No prefab starts inside a ticket tile: make one in the crew library.</Hint>}
        </Fieldset>
        {preset !== undefined && issue.trim() === '' && prompt.trim() === '' && <Hint>Give it its ticket, or say what it should do.</Hint>}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Dialog>
  );
}
