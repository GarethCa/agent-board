import { Character } from '../board/Character';
import {
  CHARACTER_MOTION_LABELS,
  CHARACTER_MOTIONS,
  CHARACTER_STYLE_LABELS,
  CHARACTER_STYLES,
  setCharacterMotion,
  setCharacterStyle,
  useCharacterMotion,
  useCharacterStyle,
  type CharacterStyle,
} from '../board/characters';
import { useSimplified } from '../design';
import { Choice, Choices, Fieldset, Hint, Segmented } from '../ui';

/** How tall a card's preview stands, in px. */
const PREVIEW_HEIGHT = 40;

/** A card's live preview: both bodies in the style, or what Off leaves in place of them. Done is each style's most distinct silhouette. */
function StylePreview({ style }: { style: CharacterStyle }) {
  const simplified = useSimplified();
  if (style === 'off') return <span className="character-choice-off">{simplified ? 'Aa' : '—'}</span>;
  return (
    <span className="character-choice-pair">
      <Character harness="claude" pose="done" style={style} height={PREVIEW_HEIGHT} />
      <Character harness="codex" pose="done" style={style} height={PREVIEW_HEIGHT} />
    </span>
  );
}

/** The four choices as cards, one for each style with its live preview: in Settings and in the board menu. */
export function CharacterStyleChoices() {
  const picked = useCharacterStyle();
  return (
    <Choices aria-label="Characters">
      {CHARACTER_STYLES.map((style) => (
        <Choice
          key={style}
          className="character-choice"
          name="character-style"
          label={CHARACTER_STYLE_LABELS[style]}
          mark={<StylePreview style={style} />}
          checked={style === picked}
          onChange={() => setCharacterStyle(style)}
        />
      ))}
    </Choices>
  );
}

/** Move on change or Still: in Settings and in the board menu. */
export function CharacterMotionControl() {
  return <Segmented aria-label="Motion" options={CHARACTER_MOTIONS.map((id) => ({ id, label: CHARACTER_MOTION_LABELS[id] }))} value={useCharacterMotion()} onChange={setCharacterMotion} />;
}

/** Settings › General › Design › Characters, shared by both designs: a character on each agent, and whether it moves. */
export function CharactersSetting() {
  const simplified = useSimplified();
  return (
    <>
      <Fieldset legend="Characters">
        <CharacterStyleChoices />
        <Hint>A small character on each agent, showing what it is doing. {simplified ? 'Off shows Icons and words.' : 'Off shows the status pill alone.'}</Hint>
      </Fieldset>
      <Fieldset legend="Motion">
        <CharacterMotionControl />
        <Hint>With Reduced motion on in System Settings, characters stay still.</Hint>
      </Fieldset>
    </>
  );
}
