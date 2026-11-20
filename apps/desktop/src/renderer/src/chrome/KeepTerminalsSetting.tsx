import { setViewSetting, useViewSettings } from '../board/view-settings';
import { Hint, Switch } from '../ui';

/**
 * Settings › Advanced › Terminals: whether an open pane's terminal and chat view stay alive while they are off screen
 * (session/kept-terminals.ts, session/kept-chats.ts). Off by default. Its saved key is still the terminals' own, so a
 * window that kept terminals keeps both. Every window follows a change: turned off, it lets go of the ones it kept.
 */
export function KeepTerminalsSetting() {
  const { keepTerminals } = useViewSettings();
  return (
    <>
      <Switch label="Keep sessions while off screen" checked={keepTerminals} onChange={(event) => setViewSetting('keepTerminals', event.target.checked)} />
      <Hint>
        Terminals and chats you have opened stay ready while they are off screen, so moving back to them doesn&apos;t stutter or draw them again. It uses more
        memory, which can matter with many agents on a machine short of it.
      </Hint>
    </>
  );
}
