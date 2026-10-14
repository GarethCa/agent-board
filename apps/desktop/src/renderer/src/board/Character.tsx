import { memo, type ReactNode } from 'react';
import { SESSION_STATES, type Harness } from '@agent-board/daemon/protocol';
import { HARNESSES } from '../harness';
import { STATE_LABELS } from '../states';

/** Every pose a character can strike: each state a subagent can be in, and handing off its result. */
export const CHARACTER_POSES = [...SESSION_STATES, 'handing-off'] as const;
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
  const body = BODIES[harness];
  const { eyes, legs, arms, prop, toppled } = FIGURES[pose];
  const color = HARNESSES[harness].color;
  return (
    <svg
      className="character"
      data-testid="character"
      data-pose={pose}
      data-harness={harness}
      data-body={body}
      role="img"
      aria-label={label === undefined ? POSE_LABELS[pose] : `${label}: ${POSE_LABELS[pose]}`}
      viewBox="0 0 32 36"
      width="28"
      height="32"
    >
      <g className="character-figure" transform={toppled ? 'translate(0 7) rotate(90 16 22)' : undefined}>
        <g style={{ stroke: INK }} strokeWidth="2" strokeLinecap="round">
          {legs.map(([x1, y1, x2, y2], index) => (
            <line key={`leg${index}`} className="character-leg" x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
          {arms.map(([x1, y1, x2, y2], index) => (
            <line key={`arm${index}`} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
        {body === 'bean' ? (
          <path d="M16 8 C22.5 8 24.5 12.5 24 19 C23.5 25.5 21 29 16 29 C10.5 29 7.8 25.5 8 18.5 C8.2 12 10 8 16 8 Z" style={{ fill: color }} />
        ) : (
          <rect x="8.5" y="8.5" width="15" height="20" rx="2.5" style={{ fill: color }} />
        )}
        <Face eyes={eyes} />
      </g>
      {prop}
    </svg>
  );
});

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
