import { useEffect, useState } from 'react';
import type { DaemonSettings } from '@agent-board/daemon/protocol';
import { useSimplified } from '../design';
import { NOTIFY_WHEN, needsYouShowsFrom, showsInFrontSwitch } from './notify-when';
import { useTechnicalDetails } from '../technical';
import { Choice, Choices, Fieldset, Field, Hint, Select, Switch, Tag } from '../ui';

type NotificationSettings = Pick<DaemonSettings, 'needsYouShows' | 'notifications' | 'notifyInFront'>;

/**
 * Under the Simplified design, one pop-up in place of the three rows: what pings, as the inbox lists it (explicit requests
 * only) or with every finished turn too. Turning notifications off and quiet hours are the Mac's (System Settings, Focus);
 * while the app is in front, only with technical details shown.
 */
function NotifyMeWhen({ settings, disabled, change }: { settings: NotificationSettings | undefined; disabled: boolean; change: (changed: Partial<NotificationSettings>) => void }) {
  const technical = useTechnicalDetails();
  return (
    <>
      <Field label="Notify me when">
        <Select
          aria-label="Notify me when"
          value={settings?.needsYouShows ?? 'explicit'}
          disabled={disabled}
          onChange={(event) => change({ needsYouShows: needsYouShowsFrom(event.target.value) })}
        >
          {NOTIFY_WHEN.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      {settings?.needsYouShows === 'turns' && <Hint>A finished turn shows in Needs you too.</Hint>}
      <Hint>To turn notifications off, use System Settings. Quiet hours follow your Mac’s Focus (System Settings › Focus).</Hint>
      {showsInFrontSwitch(technical) && (
        <>
          <Switch
            label="Also while agent-board is in front"
            checked={settings?.notifyInFront ?? false}
            disabled={disabled}
            onChange={(event) => change({ notifyInFront: event.target.checked })}
          />
          <Hint>Off: only the pill changes while you are looking at the board.</Hint>
        </>
      )}
    </>
  );
}

/**
 * Settings › Alerts › Notifications: what the needs-you inbox lists (explicit requests only, the default, or every finished turn
 * too), whether a new request raises an OS notification, and whether it does so while the app is in front. How many
 * agents are muted, which notify of nothing but still show in the list. The daemon keeps them, so every window agrees.
 */
export function NotificationsSetting({ muted, onError }: { muted: number; onError: (action: string) => (error: unknown) => void }) {
  const [settings, setSettings] = useState<NotificationSettings>();
  const [busy, setBusy] = useState(false);
  const simplified = useSimplified();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then(setSettings, onError('read the notification settings'));
    return window.agentBoard.flowEdges.onSettingsChanged((event) => setSettings(event.settings));
  }, [onError]);

  const change = (changed: Partial<NotificationSettings>) => {
    setBusy(true);
    window.agentBoard.flowEdges
      .setSettings(changed)
      .then(setSettings, onError('change the notification settings'))
      .finally(() => setBusy(false));
  };

  const disabled = settings === undefined || busy;
  const mutedHint = (
    <Hint data-testid="muted-agents">
      {muted === 0 ? 'No agent is muted.' : `${muted} muted agent${muted === 1 ? '' : 's'}.`} A tile muted from its ⋯ menu never notifies. It still shows in the list.
    </Hint>
  );
  if (simplified) {
    return (
      <>
        <NotifyMeWhen settings={settings} disabled={disabled} change={change} />
        {mutedHint}
      </>
    );
  }
  return (
    <>
      <Fieldset legend="Needs you shows">
        <Choices aria-label="Needs you shows">
          <Choice
            name="needs-you-shows"
            label={
              <>
                Explicit requests only <Tag tone="accent">default</Tag>
              </>
            }
            detail="Questions, permission prompts and agents that flag you."
            checked={(settings?.needsYouShows ?? 'explicit') === 'explicit'}
            disabled={disabled}
            onChange={() => change({ needsYouShows: 'explicit' })}
          />
          <Choice
            name="needs-you-shows"
            label="Explicit requests and finished turns"
            detail="As before: every agent whose turn ended counts as well."
            checked={settings?.needsYouShows === 'turns'}
            disabled={disabled}
            onChange={() => change({ needsYouShows: 'turns' })}
          />
        </Choices>
      </Fieldset>
      <Switch
        label="OS notifications"
        checked={settings?.notifications ?? true}
        disabled={disabled}
        onChange={(event) => change({ notifications: event.target.checked })}
      />
      <Hint>One per new request, with its reason. Clicking it opens the agent.</Hint>
      <Switch
        label="Also while agent-board is in front"
        checked={settings?.notifyInFront ?? false}
        disabled={disabled || settings?.notifications === false}
        onChange={(event) => change({ notifyInFront: event.target.checked })}
      />
      <Hint>Off: only the pill changes while you are looking at the board.</Hint>
      {mutedHint}
    </>
  );
}
