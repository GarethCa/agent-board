import { setViewSetting, useViewSettings } from '../board/view-settings';
import { Hint, Switch } from '../ui';

/**
 * Settings › Advanced › Terminals: whether an open pane's terminal stays alive while it is off screen
 * (session/kept-terminals.ts). Off by default. Every window follows a change: turned off, it lets go of the ones it kept.
 */
export function KeepTerminalsSetting() {
  const { keepTerminals } = useViewSettings();
  return (
    <>
      <Switch label="Keep terminals while off screen" checked={keepTerminals} onChange={(event) => setViewSetting('keepTerminals', event.target.checked)} />
      <Hint>
        Panes you have opened stay ready while they are off screen, so moving back to them doesn&apos;t stutter. It uses more memory, which can matter with many agents on
        a machine short of it.
      </Hint>
    </>
  );
}
