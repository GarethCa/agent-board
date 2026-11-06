// Start agents to take jobs: a queue's drain, turned on by the user. The board starts a fresh agent for each waiting
// job, as a clock does, while fewer than "at most" of the queue's jobs are taken. It is the user's switch: nothing
// starts until they turn it on, and it stops when they turn it off.
import { useState } from 'react';
import { MAX_DRAIN_AGENTS, type BoardItem, type QueueDrain, type Zone } from '@agent-board/daemon/protocol';
import { Button, Checkbox, Dialog, Fieldset, Hint, Segmented } from '../../ui';
import { FreshAgentFields } from '../FreshAgentFields';
import { openDrain, useDrainSheet } from './queue-board';
import { queueData } from './queue-card';

/** A queue's drain before it is first set, its limits filled in: Claude implementers on Sonnet, two at a time, each closed once done. */
export const NEW_DRAIN: QueueDrain = { on: false, harness: 'claude', model: 'sonnet', role: 'implementer', closeWhenDone: true, most: 2, started: [] };

const MOSTS = Array.from({ length: MAX_DRAIN_AGENTS }, (_, at) => ({ id: String(at + 1), label: String(at + 1) }));

interface DrainSheetProps {
  title: string;
  /** Its zone's name: agents start there. A queue loose on the board starts none. */
  zoneName: string | undefined;
  drain: QueueDrain;
  onChange(drain: QueueDrain): void;
  /** Saves it, turned on. */
  onStart(): void;
  /** Turns it off; agents it started keep their jobs. */
  onStop(): void;
  onCancel(): void;
  inline?: boolean;
}

export function DrainSheetView({ title, zoneName, drain, onChange, onStart, onStop, onCancel, inline }: DrainSheetProps) {
  const loose = zoneName === undefined;
  return (
    <Dialog
      title="Start agents to take jobs"
      aria-label={`Start agents for “${title}”`}
      onClose={onCancel}
      inline={inline}
      data-testid="drain-sheet"
      footerStart={
        drain.on ? (
          <Button variant="ghost" onClick={onStop}>
            Turn it off
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={loose} onClick={onStart}>
            {drain.on ? 'Save' : 'Start agents'}
          </Button>
        </>
      }
    >
      <div className="drain-sheet">
        {/* Fieldsets, not labels: a label would name, and be pressed as, the first control in it. */}
        <Fieldset legend="Each agent">
          <FreshAgentFields fresh={drain} onChange={(fresh) => onChange({ ...drain, ...fresh })} />
        </Fieldset>
        <Fieldset legend="At most at once">
          <Segmented aria-label="At most at once" options={MOSTS} value={String(drain.most)} onChange={(most) => onChange({ ...drain, most: Number(most) })} />
        </Fieldset>
        <Checkbox label="Close each once its job is done" checked={drain.closeWhenDone} onChange={(event) => onChange({ ...drain, closeWhenDone: event.target.checked })} />
        {loose ? (
          <Hint>Put the queue in a zone first: its agents start there.</Hint>
        ) : (
          <Hint>
            A fresh agent starts in {zoneName} for each waiting job, up to {drain.most} at a time (jobs you hand on count).
            <br />
            Each uses your plan: nothing holds them back but this limit.
          </Hint>
        )}
      </div>
    </Dialog>
  );
}

/** The drain sheet of the queue being set up, with what it would save; saved with `on` as Start agents or Turn it off says. */
function DrainSheetFor({ queue, zones, onSave }: { queue: BoardItem; zones: readonly Pick<Zone, 'id' | 'name'>[]; onSave(queueId: string, drain: QueueDrain): void }) {
  const data = queueData(queue.data);
  const [drain, setDrain] = useState(data.drain ?? NEW_DRAIN);
  const close = () => openDrain(undefined);
  const save = (on: boolean) => {
    onSave(queue.id, { ...drain, on });
    close();
  };
  return (
    <DrainSheetView
      title={data.title}
      zoneName={queue.zoneId === null ? undefined : (zones.find((zone) => zone.id === queue.zoneId)?.name ?? 'its zone')}
      drain={drain}
      onChange={setDrain}
      onStart={() => save(true)}
      onStop={() => save(false)}
      onCancel={close}
    />
  );
}

/** The drain sheet, when a queue asked for it: mounted once, beside the board. */
export function DrainSheetHost({ queues, zones, onSave }: { queues: readonly BoardItem[]; zones: readonly Pick<Zone, 'id' | 'name'>[]; onSave(queueId: string, drain: QueueDrain): void }) {
  const open = useDrainSheet();
  const queue = queues.find((each) => each.id === open);
  return queue === undefined ? null : <DrainSheetFor key={queue.id} queue={queue} zones={zones} onSave={onSave} />;
}
