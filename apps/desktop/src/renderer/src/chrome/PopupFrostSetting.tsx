import { Fieldset, Hint, Switch } from '../ui';
import { setPopupFrost, usePopupFrost } from '../board/popup-frost';

/** Settings › General › Appearance: whether the board behind an agent's pop-up is frosted or only dimmed. */
export function PopupFrostSetting() {
  const frost = usePopupFrost();
  return (
    <Fieldset legend="Pop-ups">
      <Switch label="Frost the board behind a pop-up" checked={frost} onChange={(event) => setPopupFrost(event.currentTarget.checked)} />
      <Hint>Blurs the board as well as dimming it, so the pop-up stands out. Off, the board is only dimmed. With reduced transparency turned on in your system's settings, it is only dimmed, a little deeper.</Hint>
    </Fieldset>
  );
}
