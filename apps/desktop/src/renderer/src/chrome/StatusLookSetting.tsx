import { setStatusLook, STATUS_LOOK_LABELS, STATUS_LOOKS, useStatusLook } from '../board/status-look';
import { Fieldset, Hint, Segmented } from '../ui';

/** Under the Simplified design: whether each agent's status is a glyph or the orange character, its word beside either. */
export function StatusLookSetting() {
  return (
    <Fieldset legend="Show each agent's status as">
      <Segmented
        aria-label="Show each agent's status as"
        options={STATUS_LOOKS.map((id) => ({ id, label: STATUS_LOOK_LABELS[id] }))}
        value={useStatusLook()}
        onChange={setStatusLook}
      />
      <Hint>The character acts out the status; the word stays beside it.</Hint>
    </Fieldset>
  );
}
