import { useEffect, useState } from 'react';
import type { DaemonSettings } from '@agent-board/daemon/protocol';
import { Choice, Choices, Fieldset, Hint, SectionLabel, Switch, Tag } from '../ui';

type NotificationSettings = Pick<DaemonSettings, 'needsYouShows' | 'notifications' | 'notifyInFront'>;

/**
 * Settings › Notifications: what the needs-you inbox lists (explicit requests only, the default, or every finished turn
 * too), whether a new request raises an OS notification, and whether it does so while the app is in front. How many
 * agents are muted, which notify of nothing but still show in the list. The daemon keeps them, so every window agrees.
 */
export function NotificationsSetting({ muted, onError }: { muted: number; onError: (action: string) => (error: unknown) => void }) {
  const [settings, setSettings] = useState<NotificationSettings>();
  const [busy, setBusy] = useState(false);

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
  return (
    <>
      <SectionLabel as="h4">Notifications</SectionLabel>
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
      <Hint data-testid="muted-agents">
        {muted === 0 ? 'No agent is muted.' : `${muted} muted agent${muted === 1 ? '' : 's'}.`} A tile muted from its ⋯ menu never notifies. It still shows in the list.
      </Hint>
    </>
  );
}
