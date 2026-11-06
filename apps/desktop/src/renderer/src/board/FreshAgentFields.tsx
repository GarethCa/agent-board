// How a fresh agent the board starts on its own is set up: its harness, role and model (each blank for the default).
// A clock's runs use it, and a queue's drain.
import { HARNESSES as HARNESS_IDS, type ClockFreshAgent } from '@agent-board/daemon/protocol';
import { Input, Select } from '../ui';
import { HARNESSES } from '../harness';

export function FreshAgentFields({ fresh, onChange }: { fresh: ClockFreshAgent; onChange(fresh: ClockFreshAgent): void }) {
  return (
    <div className="clock-fresh">
      <Select aria-label="Harness" value={fresh.harness} onChange={(event) => onChange({ ...fresh, harness: event.target.value as ClockFreshAgent['harness'] })}>
        {HARNESS_IDS.map((harness) => (
          <option key={harness} value={harness}>
            {HARNESSES[harness].label}
          </option>
        ))}
      </Select>
      <Input aria-label="Role" placeholder="Role (default)" value={fresh.role ?? ''} onChange={(event) => onChange({ ...fresh, role: event.target.value.trim() === '' ? null : event.target.value })} />
      <Input aria-label="Model" placeholder="Model (default)" value={fresh.model ?? ''} onChange={(event) => onChange({ ...fresh, model: event.target.value.trim() === '' ? null : event.target.value })} />
    </div>
  );
}
