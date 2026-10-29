import { useEffect, useState } from 'react';
import { DEFAULT_USAGE_THRESHOLDS, type DaemonSettings, type UsageReading, type UsageThresholds } from '@agent-board/daemon/protocol';
import { Fieldset, Hint, SectionLabel, Switch } from '../ui';

type OnError = (action: string) => (error: unknown) => void;

/** Each threshold's line: what happens, in which window, to which zones. */
const THRESHOLDS: { key: keyof UsageThresholds; window: string; reads: 'fiveHour' | 'sevenDay'; does: string }[] = [
  { key: 'fiveHourOnlyHigh', window: '5-hour window', reads: 'fiveHour', does: 'Only High zones start new agents at' },
  { key: 'fiveHourPauseLow', window: '5-hour window', reads: 'fiveHour', does: "Low zones' idle agents may be paused at" },
  { key: 'sevenDayOnlyHigh', window: '7-day window', reads: 'sevenDay', does: 'Only High zones start new agents at' },
];

/** `now 72%` for a window of a fresh reading; nothing without one. */
const nowText = (reading: UsageReading | undefined, window: 'fiveHour' | 'sevenDay'): string => {
  const used = reading === undefined || reading.stale ? undefined : reading[window]?.usedPercent;
  return used === undefined ? '' : ` · now ${Math.round(used)}%`;
};

/**
 * Settings › Usage: the thresholds, which speak in the zones' priorities (High, Normal or Low, from each zone's tab),
 * and under them the switch that lets the Captain pace work by them. Off until the user turns it on; the daemon
 * refuses every budget hold while it is off.
 */
export function UsageSetting({ onError }: { onError: OnError }) {
  const [settings, setSettings] = useState<Pick<DaemonSettings, 'usagePacing' | 'usageThresholds'>>();
  const [reading, setReading] = useState<UsageReading>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then(setSettings, onError('read the usage settings'));
    window.agentBoard.orchestrators.usage().then(setReading, () => {});
    const offUsage = window.agentBoard.orchestrators.onUsage((event) => setReading(event.usage));
    const offSettings = window.agentBoard.flowEdges.onSettingsChanged((event) => setSettings(event.settings));
    return () => {
      offUsage();
      offSettings();
    };
  }, [onError]);

  const thresholds = settings?.usageThresholds ?? DEFAULT_USAGE_THRESHOLDS;
  const save = (change: Partial<DaemonSettings>, action: string) => window.agentBoard.flowEdges.setSettings(change).then(setSettings, onError(action));

  return (
    <>
      <SectionLabel as="h4">Usage</SectionLabel>
      <Fieldset legend="Thresholds">
        <Hint>Each zone&apos;s priority is on its tab. The Captain reads these with agent-board usage priorities.</Hint>
        {THRESHOLDS.map(({ key, window, reads, does }) => (
          <label key={key} className="usage-threshold">
            <span className="usage-threshold-text">
              <small>
                {window}
                {nowText(reading, reads)}
              </small>
              {does} <b>{thresholds[key]}%</b>
            </span>
            <input
              type="range"
              min={1}
              max={100}
              value={thresholds[key]}
              aria-label={`${window}: ${does}`}
              onChange={(event) => setSettings((now) => now && { ...now, usageThresholds: { ...now.usageThresholds, [key]: Number(event.target.value) } })}
              onPointerUp={(event) => void save({ usageThresholds: { ...thresholds, [key]: Number(event.currentTarget.value) } }, 'change the usage thresholds')}
              onKeyUp={(event) => void save({ usageThresholds: { ...thresholds, [key]: Number(event.currentTarget.value) } }, 'change the usage thresholds')}
            />
          </label>
        ))}
      </Fieldset>
      <Fieldset legend="Pacing">
        <Switch
          label="Let the Captain pace work by usage"
          checked={settings?.usagePacing ?? false}
          disabled={settings === undefined}
          onChange={(event) => void save({ usagePacing: event.target.checked }, 'change pacing by usage')}
        />
        <Hint>{settings?.usagePacing === true ? 'On' : 'Off'} · uses the thresholds above</Hint>
        <div className="usage-warning" role="note">
          When on, the Captain may hold new starts and hand-offs, and pause idle agents, in zones under your thresholds. Each hold says why, on the tile or the
          zone&apos;s tab and in the Captain&apos;s panel, with Override. It never interrupts a turn.
        </div>
      </Fieldset>
    </>
  );
}
