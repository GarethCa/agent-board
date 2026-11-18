import { Pencil } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { MAX_CREW_DESCRIPTION_LENGTH, type Zone } from '@agent-board/daemon/protocol';
import { Button, Dialog, ErrorText, Field, Hint, Kbd, Select, Textarea } from '../ui';
import { keyText } from '../keys/registry';
import { useAction } from '../use-action';

/** An agent on the board that may draft it: running, by its session. */
export interface DrafterChoice {
  sessionId: string;
  name: string;
  zoneId: string | null;
}

interface DescribeCrewDialogProps {
  /** The zones a new drafter can start in. */
  zones: readonly Zone[];
  /** The zone it was asked from: a new drafter starts there. Without, it asks, starting on `suggested`. */
  zone?: Zone;
  suggested?: Zone;
  /** The agents on the board, running, that may draft it instead. */
  agents: readonly DrafterChoice[];
  onClose(): void;
  /** Drawn open in place, for the gallery. */
  inline?: boolean;
}

/** Who drafts it, as the select holds it: a new agent, or one on the board by its session. */
const NEW_DRAFTER = 'new';

/**
 * Describe a crew: what it should do and how, and who drafts it, a new agent (Claude on Sonnet, which closes as its draft
 * opens) or one on the board, which carries on with its own work. Drafting changes nothing: the draft waits for the user.
 */
export function DescribeCrewDialog({ zones, zone: asked, suggested, agents, onClose, inline = false }: DescribeCrewDialogProps) {
  const [description, setDescription] = useState('');
  const [drafter, setDrafter] = useState(NEW_DRAFTER);
  const [zoneId, setZoneId] = useState(asked?.id ?? suggested?.id ?? zones[0]?.id);
  const [sent, setSent] = useState<{ name: string; started: boolean }>();
  const { busy, error, run } = useAction();
  const fresh = drafter === NEW_DRAFTER;
  const zone = zones.find((each) => each.id === zoneId);
  const ready = description.trim() !== '' && (!fresh || zone !== undefined);
  const zoneName = (id: string | null) => zones.find((each) => each.id === id)?.name;

  const submit = () => {
    if (!ready || busy) return;
    run(
      () => window.agentBoard.orchestrators.describeCrew({ description: description.trim(), ...(fresh ? { zoneId: zone!.id } : { drafter }) }),
      (done) => setSent({ name: done.name, started: done.started }),
    );
  };
  const submitOnKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  if (sent !== undefined) {
    return (
      <Dialog
        aria-label="Drafting"
        title="Drafting…"
        onClose={onClose}
        inline={inline}
        data-testid="describe-crew-drafting"
        footer={
          <Button variant="primary" autoFocus onClick={onClose}>
            Close
          </Button>
        }
      >
        <p className="describe-crew-sub">
          {sent.name} is drafting it: about a minute. You can close this: the draft waits in Settings › Prefabs › Drafts until you open or delete it.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      aria-label="Describe a crew"
      title="Describe a crew"
      onClose={() => !busy && onClose()}
      inline={inline}
      data-testid="describe-crew"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={<Pencil />} loading={busy} disabled={!ready}>
            Draft it
            <Kbd aria-hidden>{keyText('dialog.submit')}</Kbd>
          </Button>
        </>
      }
    >
      <div className="describe-crew" onKeyDown={submitOnKey}>
        <p className="describe-crew-sub">An agent drafts it; you tweak it and save it.</p>
        <Field label="What should this crew do, and how?">
          <Textarea
            aria-label="Describe the crew"
            className="describe-crew-text"
            autoFocus
            value={description}
            maxLength={MAX_CREW_DESCRIPTION_LENGTH}
            placeholder="Every weekday at 8, an agent goes through the zone’s queue and drafts a ticket for each job. A terse reviewer checks the wording until it’s happy. Then it waits for my OK."
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="Who drafts it" hint="Any agent you pick. A new one closes when the draft opens; one already on the board carries on with its work.">
          <Select aria-label="Who drafts it" value={drafter} onChange={(event) => setDrafter(event.target.value)}>
            <option value={NEW_DRAFTER}>A new agent · Claude · sonnet</option>
            {agents.map((agent) => (
              <option key={agent.sessionId} value={agent.sessionId}>
                {zoneName(agent.zoneId) === undefined ? agent.name : `${agent.name} (${zoneName(agent.zoneId)})`}
              </option>
            ))}
          </Select>
        </Field>
        {fresh && asked === undefined && zones.length > 0 && (
          <Field label="Zone" hint="Where the new agent starts.">
            <Select aria-label="Zone" value={zoneId ?? ''} onChange={(event) => setZoneId(event.target.value)}>
              {zones.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {fresh && zones.length === 0 && <Hint>A new agent starts in a zone, and the board has none yet: pick an agent on the board, or add a zone.</Hint>}
        <Hint>
          Drafting only writes a file and calls <code>prefab_draft</code>. Nothing is saved, started or changed until you press Save.
        </Hint>
        {error !== undefined && <ErrorText>{error}</ErrorText>}
      </div>
    </Dialog>
  );
}
