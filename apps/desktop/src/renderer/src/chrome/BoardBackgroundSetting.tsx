import { useRef, type KeyboardEvent } from 'react';
import {
  BOARD_BACKGROUND_LABELS,
  BOARD_BACKGROUNDS,
  setBoardBackground,
  useBoardBackground,
  type BoardBackground,
} from '../board/board-background';
import { Fieldset, Hint } from '../ui';

/**
 * Settings › General › Appearance › Board background: how the desk behind the board is drawn, one swatch for each. A
 * radio group: arrows move between the swatches and pick as they go, so every board shows it at once.
 */
export function BoardBackgroundSetting() {
  const picked = useBoardBackground();
  const buttons = useRef(new Map<BoardBackground, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent, at: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = BOARD_BACKGROUNDS[(at + step + BOARD_BACKGROUNDS.length) % BOARD_BACKGROUNDS.length]!;
    setBoardBackground(next);
    buttons.current.get(next)?.focus();
  };

  return (
    <Fieldset legend="Board background">
      <div className="backdrop-choices" role="radiogroup" aria-label="Board background">
        {BOARD_BACKGROUNDS.map((id, at) => (
          <button
            key={id}
            ref={(button) => void (button ? buttons.current.set(id, button) : buttons.current.delete(id))}
            type="button"
            role="radio"
            className="backdrop-choice"
            aria-checked={id === picked}
            aria-label={BOARD_BACKGROUND_LABELS[id].name}
            tabIndex={id === picked ? 0 : -1}
            onClick={() => setBoardBackground(id)}
            onKeyDown={(event) => onKeyDown(event, at)}
          >
            <span className="board-backdrop-swatch" data-board-background={id} aria-hidden />
            <span className="backdrop-choice-name">{BOARD_BACKGROUND_LABELS[id].name}</span>
          </button>
        ))}
      </div>
      <Hint>{BOARD_BACKGROUND_LABELS[picked].hint} Every theme and both designs keep it quiet behind the tiles.</Hint>
    </Fieldset>
  );
}
