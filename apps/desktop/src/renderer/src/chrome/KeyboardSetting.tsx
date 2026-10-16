import { setExtendedShortcuts, useExtendedShortcuts } from '../keys/extended-shortcuts';
import { keyText } from '../keys/registry';
import { Hint, Switch } from '../ui';

/** The "Extended keyboard shortcuts" setting: the keys added since the key registry, on unless turned off. */
export function KeyboardSetting() {
  const extended = useExtendedShortcuts();
  return (
    <>
      <Switch label="Extended keyboard shortcuts" checked={extended} onChange={(event) => setExtendedShortcuts(event.target.checked)} />
      <Hint>
        The newer keys, such as {keyText('move.cheatSheet')} and {keyText('move.cheatSheetAnywhere')} for the cheat sheet. Turned off, the app keeps only the keys it always had.
      </Hint>
    </>
  );
}
