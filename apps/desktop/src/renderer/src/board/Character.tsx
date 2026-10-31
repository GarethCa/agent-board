import { memo, type ReactNode } from 'react';
import { SESSION_STATES, type Harness } from '@agent-board/daemon/protocol';
import { HARNESSES } from '../harness';
import { STATE_LABELS } from '../states';

/**
 * Every pose a character can strike: each state a subagent can be in, handing off its result, and waiting on a
 * command it left running.
 */
export const CHARACTER_POSES = [...SESSION_STATES, 'handing-off', 'on-command'] as const;
export type CharacterPose = (typeof CHARACTER_POSES)[number];

const POSE_LABELS: Record<CharacterPose, string> = { ...STATE_LABELS, 'handing-off': 'handing off' };

/** The body each harness's characters have. */
const BODIES: Record<Harness, 'bean' | 'block'> = { claude: 'bean', codex: 'block' };

// Paint comes from theme tokens, set through `style` because presentation attributes can't hold var().
const INK = 'var(--figure-ink)';
const PAPER = 'var(--figure-paper)';

type Eyes = 'open' | 'ahead' | 'up' | 'closed' | 'crossed' | 'happy';

/** A limb: a line from `x1 y1` (hip or shoulder) to `x2 y2`. */
type Limb = readonly [x1: number, y1: number, x2: number, y2: number];

/** What changes between poses: the eyes, the limbs, and what the character holds or shows. */
interface Figure {
  eyes: Eyes;
  legs: readonly [Limb, Limb];
  arms: readonly [Limb, Limb];
  prop?: ReactNode;
  /** Lies on its side. */
  toppled?: boolean;
}

const STANDING = [
  [13, 28, 13, 33],
  [19, 28, 19, 33],
] as const;
const ARMS_DOWN = [
  [9, 19, 6, 24],
  [23, 19, 26, 24],
] as const;

const FIGURES: Record<CharacterPose, Figure> = {
  // Mid-stride, with motion lines behind it.
  running: {
    eyes: 'ahead',
    // Straight down: the walk swings them (app.css), and holds them mid-stride when motion is reduced.
    legs: STANDING,
    arms: [[9, 19, 5.5, 21], [23, 19, 26.5, 16.5]],
    prop: (
      <g style={{ stroke: INK }} strokeWidth="1.2" strokeLinecap="round" opacity="0.5">
        <line x1="0.5" y1="14" x2="4" y2="14" />
        <line x1="0" y1="19" x2="4.5" y2="19" />
        <line x1="1" y1="24" x2="4" y2="24" />
      </g>
    ),
  },
  // Eyes up, a trail of dots above its head.
  thinking: {
    eyes: 'up',
    legs: STANDING,
    arms: [[9, 19, 6, 24], [23, 19, 20, 23]],
    prop: (
      <g style={{ fill: INK }} opacity="0.65">
        <circle cx="21" cy="5.5" r="1.1" />
        <circle cx="25" cy="3.8" r="1.3" />
        <circle cx="29.2" cy="2" r="1.5" />
      </g>
    ),
  },
  // A hand raised.
  waiting: {
    eyes: 'open',
    legs: STANDING,
    arms: [[9, 19, 6, 24], [23, 17, 28, 8]],
    prop: <circle cx="28.4" cy="6.6" r="1.8" style={{ fill: INK }} />,
  },
  // Holding up a shield.
  'needs-permission': {
    eyes: 'open',
    legs: STANDING,
    arms: [[9, 19, 6, 24], [23, 19, 25, 21]],
    prop: (
      <path
        d="M22.5 14.5 L30 16.5 L30 21.5 C30 25.5 26.2 27.8 26.2 27.8 C26.2 27.8 22.5 25.5 22.5 21.5 Z"
        style={{ fill: 'var(--state-needs-permission)', stroke: PAPER }}
        strokeWidth="0.8"
      />
    ),
  },
  // Eyes shut, dozing.
  idle: {
    eyes: 'closed',
    legs: STANDING,
    arms: [[9, 20, 7.5, 25], [23, 20, 24.5, 25]],
    prop: (
      <g style={{ fill: INK, fontFamily: 'var(--font-sans)', fontWeight: 'var(--weight-bold)' }} opacity="0.6">
        <text x="24" y="8" fontSize="6">
          z
        </text>
        <text x="28.5" y="3.8" fontSize="4.5">
          z
        </text>
      </g>
    ),
  },
  // Watching an hourglass.
  'rate-limited': {
    eyes: 'up',
    legs: STANDING,
    arms: [[9, 19, 6, 24], [23, 19, 25.5, 14]],
    prop: (
      <g style={{ stroke: INK }} strokeWidth="0.9" strokeLinejoin="round">
        <path d="M25 2.5 H31 L28 7.5 L31 12.5 H25 L28 7.5 Z" style={{ fill: PAPER }} />
        <path d="M26.6 11.8 H29.4 L28 9.6 Z" style={{ fill: 'var(--state-rate-limited)' }} stroke="none" />
      </g>
    ),
  },
  // Toppled over, with crossed-out eyes.
  failed: { eyes: 'crossed', legs: STANDING, arms: ARMS_DOWN, toppled: true },
  // Happy, with a tick.
  done: {
    eyes: 'happy',
    legs: STANDING,
    arms: ARMS_DOWN,
    prop: (
      <g>
        <circle cx="27" cy="6" r="4.2" style={{ fill: 'var(--state-done)' }} />
        <path d="M25 6.2 L26.5 7.7 L29.2 4.6" fill="none" style={{ stroke: PAPER }} strokeWidth="1.3" strokeLinecap="round" />
      </g>
    ),
  },
  // Holding up a stopwatch, timing what it left running.
  'on-command': {
    eyes: 'open',
    legs: STANDING,
    arms: [[9, 19, 6, 24], [23, 19, 25.5, 14]],
    prop: (
      <g style={{ stroke: INK }} strokeWidth="0.9" strokeLinecap="round">
        <line x1="28" y1="1.4" x2="28" y2="3" />
        <circle cx="28" cy="8" r="4.8" style={{ fill: 'var(--state-on-command)' }} />
        <path d="M28 8 L28 5.3 M28 8 L30 9.2" style={{ stroke: PAPER }} strokeWidth="1.1" />
      </g>
    ),
  },
  // Carrying a doc: its result, which it drops as it leaves.
  'handing-off': {
    eyes: 'ahead',
    legs: STANDING,
    arms: [[9, 19, 21, 21], [23, 19, 25, 21]],
    prop: (
      <g className="character-doc">
        <rect x="20" y="16" width="9.5" height="12" rx="1" style={{ fill: PAPER, stroke: INK }} strokeWidth="0.8" />
        <path d="M22 19.5 H27.5 M22 22 H27.5 M22 24.5 H26" style={{ stroke: INK }} strokeWidth="0.7" opacity="0.6" />
      </g>
    ),
  },
};

/**
 * A small robot standing for a subagent: its pose and face show what it is doing, its body which harness it runs
 * (a bean for Claude, a block for Codex), in the harness's colour.
 */
export const Character = memo(function Character({
  harness,
  pose,
  label,
}: {
  harness: Harness;
  pose: CharacterPose;
  /** What the subagent is, e.g. `Explore`; read out with its pose. */
  label?: string;
}) {
  const figure = FIGURES[pose];
  return (
    <svg
      className="character"
      data-testid="character"
      data-pose={pose}
      data-harness={harness}
      data-body={BODIES[harness]}
      role="img"
      aria-label={label === undefined ? POSE_LABELS[pose] : `${label}: ${POSE_LABELS[pose]}`}
      viewBox="0 0 32 36"
      width="28"
      height="32"
    >
      <g className="character-figure" transform={figure.toppled ? 'translate(0 7) rotate(90 16 22)' : undefined}>
        <Body harness={harness} figure={figure} />
      </g>
      {figure.prop}
    </svg>
  );
});

/** How tall the Captain is drawn in each place it appears, in px. */
export const CAPTAIN_SIZES = { toolbar: 18, bubble: 22, avatar: 28, 'first-run': 200 } as const;

/** Standing at ease: the Captain's, and a message sender's. */
const AT_EASE: Figure = { eyes: 'open', legs: STANDING, arms: ARMS_DOWN };

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
      <Body harness="claude" figure={AT_EASE} />
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

/** A character standing at ease, eyes open and arms down, in its harness's body and colour: who a message is from. */
export const Sender = memo(function Sender({ harness }: { harness: Harness }) {
  return (
    <svg className="character" data-testid="sender-figure" data-harness={harness} data-body={BODIES[harness]} aria-hidden viewBox="0 0 32 36" width="28" height="32">
      <Body harness={harness} figure={AT_EASE} />
    </svg>
  );
});

/** A figure's limbs, body and face, in its harness's body and colour. */
function Body({ harness, figure: { eyes, legs, arms } }: { harness: Harness; figure: Figure }) {
  return (
    <>
      <g style={{ stroke: INK }} strokeWidth="2" strokeLinecap="round">
        {legs.map(([x1, y1, x2, y2], index) => (
          <line key={`leg${index}`} className="character-leg" x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
        {arms.map(([x1, y1, x2, y2], index) => (
          <line key={`arm${index}`} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
      {BODIES[harness] === 'bean' ? (
        <path d="M16 8 C22.5 8 24.5 12.5 24 19 C23.5 25.5 21 29 16 29 C10.5 29 7.8 25.5 8 18.5 C8.2 12 10 8 16 8 Z" style={{ fill: HARNESSES[harness].color }} />
      ) : (
        <rect x="8.5" y="8.5" width="15" height="20" rx="2.5" style={{ fill: HARNESSES[harness].color }} />
      )}
      <Face eyes={eyes} />
    </>
  );
}

function Face({ eyes }: { eyes: Eyes }) {
  const at = [13, 19];
  switch (eyes) {
    case 'closed':
      return (
        <g style={{ stroke: PAPER }} strokeWidth="1.3" strokeLinecap="round">
          {at.map((x) => (
            <line key={x} x1={x - 1.8} y1="16" x2={x + 1.8} y2="16" />
          ))}
        </g>
      );
    case 'crossed':
      return (
        <g style={{ stroke: PAPER }} strokeWidth="1.3" strokeLinecap="round">
          {at.map((x) => (
            <path key={x} d={`M${x - 1.6} 13.9 L${x + 1.6} 17.1 M${x + 1.6} 13.9 L${x - 1.6} 17.1`} />
          ))}
        </g>
      );
    case 'happy':
      return (
        <g fill="none" style={{ stroke: PAPER }} strokeWidth="1.3" strokeLinecap="round">
          {at.map((x) => (
            <path key={x} d={`M${x - 1.8} 16.3 Q${x} 13.6 ${x + 1.8} 16.3`} />
          ))}
        </g>
      );
    default: {
      // Pupils centred, looking where it goes, or up.
      const [dx, dy] = eyes === 'ahead' ? [0.8, 0] : eyes === 'up' ? [0.3, -1] : [0, 0];
      return (
        <g>
          {at.map((x) => (
            <g key={x}>
              <circle cx={x} cy="15.5" r="2.3" style={{ fill: PAPER }} />
              <circle cx={x + dx} cy={15.5 + dy} r="1.1" style={{ fill: INK }} />
            </g>
          ))}
        </g>
      );
    }
  }
}
