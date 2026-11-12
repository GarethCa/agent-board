import { memo } from 'react';
import type { AgentFace, AgentProp } from '@agent-board/daemon/character';
import type { Harness } from '@agent-board/daemon/protocol';
import { STATE_LABELS } from '../states';
import { BeanBody, characterDrawing, pixelSnapped, type CharacterBody, type CharacterPose } from './character-figures';
import type { DrawnStyle } from './characters';

/** Each pose in words, as the tile's state says it. */
export const POSE_LABELS: Record<CharacterPose, string> = { ...STATE_LABELS, reading: 'reading', writing: 'writing code', testing: 'testing', 'waiting-on-review': 'waiting on review' };

/** The body each harness's characters have: every agent shares one colour, so the shape tells them apart. */
const BODIES: Record<Harness, CharacterBody> = { claude: 'bean', codex: 'block' };

const INK = 'var(--figure-ink)';

/**
 * A small robot standing for an agent or subagent: its pose and face show what it is doing, its body which harness it
 * runs (a bean for Claude, a block for Codex), drawn in `style`, `height` px tall (Pixel snaps its height so it never
 * blurs). An agent's own pose may carry a `face` and a `prop` it gave it, drawn in place of the pose's own.
 */
export const Character = memo(function Character({
  harness,
  pose,
  face,
  prop,
  label,
  style = 'bean',
  height = 32,
  testId = 'character',
  decorative = false,
}: {
  harness: Harness;
  pose: CharacterPose;
  face?: AgentFace;
  prop?: AgentProp;
  /** What it is, e.g. `Explore`; read out with its pose. */
  label?: string;
  style?: DrawnStyle;
  height?: number;
  testId?: string;
  /** The word beside it says all it does: screen readers skip it. */
  decorative?: boolean;
}) {
  const { viewBox, drawing } = characterDrawing(style, BODIES[harness], pose, face, prop);
  const [, , boxWidth = 1, boxHeight = 1] = viewBox.split(' ').map(Number);
  const tall = style === 'pixel' ? pixelSnapped(height) : height;
  return (
    <svg
      className="character"
      data-testid={testId}
      data-pose={pose}
      data-face={face}
      data-prop={prop}
      data-harness={harness}
      data-body={BODIES[harness]}
      data-style={style}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label === undefined ? POSE_LABELS[pose] : `${label}: ${POSE_LABELS[pose]}` })}
      viewBox={viewBox}
      width={Math.round((tall * boxWidth) / boxHeight)}
      height={tall}
    >
      {drawing}
    </svg>
  );
});

/** How tall the Captain is drawn in each place it appears, in px. */
export const CAPTAIN_SIZES = { toolbar: 18, bubble: 22, avatar: 28, 'first-run': 200 } as const;

/**
 * The Captain: Claude's character standing at ease in a pirate tricorn. The hat is near-black with a hairline of the
 * figure's ink, so it reads on a dark desk too, with a bone-white skull and crossbones on its crown.
 */
export const Captain = memo(function Captain({ size }: { size: keyof typeof CAPTAIN_SIZES }) {
  const height = CAPTAIN_SIZES[size];
  return (
    <svg
      className="captain"
      data-testid="captain"
      data-size={size}
      role="img"
      aria-label="The Captain"
      // Taller than a character's, for the crown of the hat.
      viewBox="0 -4 32 40"
      width={Math.round(height * 0.8)}
      height={height}
    >
      <BeanBody body="bean" paint="var(--harness-claude)" />
      {/* A hairline at every size: never wider than 1 px, so the large Captain's hat stays near-black. */}
      <g style={{ fill: 'var(--figure-hat)', stroke: INK }} strokeWidth={Math.min(0.6, 40 / height)} strokeLinejoin="round">
        <path d="M10.6 10 Q16 -2.2 21.4 10 Z" />
        <path d="M4.5 11.2 Q16 5.4 27.5 11.2 Q22 9.2 16 9.5 Q10 9.2 4.5 11.2 Z" />
      </g>
      <circle cx="16" cy="5.4" r="1.4" style={{ fill: 'var(--figure-hat-emblem)' }} />
      <path d="M14 8.1 L18 7.2 M14 7.2 L18 8.1" fill="none" style={{ stroke: 'var(--figure-hat-emblem)' }} strokeWidth="0.7" strokeLinecap="round" />
    </svg>
  );
});

/** A character standing at ease, eyes open and arms down, in its harness's body: who a message is from. */
export const Sender = memo(function Sender({ harness }: { harness: Harness }) {
  return (
    <svg className="character" data-testid="sender-figure" data-harness={harness} data-body={BODIES[harness]} aria-hidden viewBox="0 0 32 36" width="28" height="32">
      <BeanBody body={BODIES[harness]} />
    </svg>
  );
});
