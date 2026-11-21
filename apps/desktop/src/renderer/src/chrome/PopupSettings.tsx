import { Fieldset, Hint, Switch } from '../ui';
import { setPopupFill, usePopupFill } from '../board/popup-fill';
import { setPopupFrost, usePopupFrost } from '../board/popup-frost';
import { POPUP_CAP, POPUP_LAPTOP } from '../board/popup-size';

/** Settings › General › Appearance: whether the board behind an agent's pop-up is frosted or only dimmed, and whether it fills a wide screen. */
export function PopupSettings() {
  const frost = usePopupFrost();
  const fill = usePopupFill();
  return (
    <Fieldset legend="Pop-ups">
      <Switch label="Frost the board behind a pop-up" checked={frost} onChange={(event) => setPopupFrost(event.currentTarget.checked)} />
      <Hint>Blurs the board as well as dimming it, so the pop-up stands out. Off, the board is only dimmed. With reduced transparency turned on in your system's settings, it is only dimmed, a little deeper.</Hint>
      <Switch label="Pop-up fills a wide screen" checked={fill} onChange={(event) => setPopupFill(event.currentTarget.checked)} />
      <Hint>
        Off, a pop-up opens {POPUP_CAP} px wide, centred, on a board wider than a laptop's (more than {POPUP_LAPTOP} px less its margins), and a session window maximised on the board stops at {POPUP_CAP} px on a screen wider than that. On, both fill the board. The button beside its Chat | Terminal switch flips this too.
      </Hint>
    </Fieldset>
  );
}
