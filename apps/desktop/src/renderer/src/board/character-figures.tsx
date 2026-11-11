// How a character is drawn in each style. A drawing depends only on its style, body and pose, so each is made once and
// kept: a tile that redraws hands React the same elements, which it skips, however many agents are on the board.

import type { ReactNode } from 'react';
import type { CharacterPose } from '@agent-board/daemon/character';
import type { DrawnStyle } from './characters';

// Every pose a character can strike: the board's, and the ones an agent sets for its work.
export { CHARACTER_POSES, type CharacterPose } from '@agent-board/daemon/character';

/** A character's body: round for Claude, square for Codex. */
export type CharacterBody = 'bean' | 'block';

type Face = 'blank' | 'up' | 'ahead' | 'down' | 'focus' | 'open' | 'side' | 'wide' | 'happy' | 'half' | 'closed' | 'crossed';
type Stance = 'stand' | 'tilt' | 'busy' | 'hold' | 'carry' | 'wave' | 'hop' | 'sit' | 'sleep' | 'topple';
type Prop = 'boot' | 'dots' | 'gear' | 'book' | 'pencil' | 'flask' | 'stopwatch' | 'docclock' | 'doc' | 'bubble' | 'hourglass' | 'tick' | 'mug' | 'zz' | 'alert' | 'plug';

// Paint comes from theme tokens, set through `style` because presentation attributes can't hold var().
const INK = 'var(--figure-ink)';
const PAPER = 'var(--figure-paper)';
/** A body's paint, one for every harness and design (app.css). */
const BODY_CLASS = 'character-body';
const EYE = 'var(--figure-eye)';

const WORK = 'var(--accent)';
const NEEDS_YOU = 'var(--state-waiting)';
const LIMIT = 'var(--state-rate-limited)';
const FAILED = 'var(--state-failed)';
const DONE = 'var(--state-done)';
const COMMAND = 'var(--state-on-command)';
const FLOW = 'var(--state-handing-off-ink)';
const PAUSED = 'var(--state-hibernated)';
const RESTING = 'var(--state-stopped-by-restart)';

/** What a pose is: the face, the stance and the prop, with the board's colour for it. */
interface Figure {
  face: Face;
  stance: Stance;
  prop: Prop;
  tone: string;
}

const FIGURES: Record<CharacterPose, Figure> = {
  starting: { face: 'blank', stance: 'stand', prop: 'boot', tone: WORK },
  thinking: { face: 'up', stance: 'tilt', prop: 'dots', tone: WORK },
  running: { face: 'ahead', stance: 'busy', prop: 'gear', tone: WORK },
  reading: { face: 'down', stance: 'hold', prop: 'book', tone: WORK },
  writing: { face: 'focus', stance: 'hold', prop: 'pencil', tone: WORK },
  testing: { face: 'focus', stance: 'hold', prop: 'flask', tone: WORK },
  'on-command': { face: 'open', stance: 'hold', prop: 'stopwatch', tone: COMMAND },
  'waiting-on-review': { face: 'side', stance: 'stand', prop: 'docclock', tone: PAUSED },
  'handing-off': { face: 'ahead', stance: 'carry', prop: 'doc', tone: FLOW },
  waiting: { face: 'wide', stance: 'wave', prop: 'bubble', tone: NEEDS_YOU },
  'needs-permission': { face: 'wide', stance: 'wave', prop: 'bubble', tone: NEEDS_YOU },
  'rate-limited': { face: 'up', stance: 'stand', prop: 'hourglass', tone: LIMIT },
  done: { face: 'happy', stance: 'hop', prop: 'tick', tone: DONE },
  idle: { face: 'half', stance: 'sit', prop: 'mug', tone: RESTING },
  hibernated: { face: 'closed', stance: 'sleep', prop: 'zz', tone: PAUSED },
  failed: { face: 'crossed', stance: 'topple', prop: 'alert', tone: FAILED },
  'stopped-by-restart': { face: 'blank', stance: 'stand', prop: 'plug', tone: RESTING },
};

/** A prop in its 12 by 12 box: outlines in ink, fills in paper and the board's colour for the pose. */
function propDrawing(prop: Prop, tone: string): ReactNode {
  const hair = { strokeWidth: 0.9 };
  switch (prop) {
    case 'dots':
      return (
        <g style={{ fill: tone }}>
          <circle cx="2" cy="10" r="1.2" />
          <circle cx="5.6" cy="6.6" r="1.5" />
          <circle cx="9.6" cy="2.8" r="1.9" />
        </g>
      );
    case 'gear':
      return (
        <>
          <circle cx="6" cy="6" r="4.4" fill="none" style={{ stroke: tone }} strokeWidth="2.4" strokeDasharray="2.1 1.75" />
          <circle cx="6" cy="6" r="3.2" style={{ fill: tone }} />
          <circle cx="6" cy="6" r="1.2" style={{ fill: PAPER }} />
        </>
      );
    case 'book':
      return (
        <>
          <path d="M0.8 2.6 Q3.4 1.6 6 3.2 Q8.6 1.6 11.2 2.6 V10.2 Q8.6 9.2 6 10.8 Q3.4 9.2 0.8 10.2 Z" style={{ fill: PAPER, stroke: INK }} {...hair} strokeLinejoin="round" />
          <path d="M6 3.2 V10.8" style={{ stroke: INK }} strokeWidth="0.8" />
          <path d="M2.2 5 Q3.6 4.5 4.8 5.2 M2.2 7 Q3.6 6.5 4.8 7.2 M7.2 5.2 Q8.4 4.5 9.8 5 M7.2 7.2 Q8.4 6.5 9.8 7" fill="none" style={{ stroke: tone }} strokeWidth="0.8" strokeLinecap="round" />
        </>
      );
    case 'pencil':
      return (
        <>
          <path d="M1.4 10.6 L2 7.8 L8.4 1.4 L10.6 3.6 L4.2 10 Z" style={{ fill: tone, stroke: INK }} {...hair} strokeLinejoin="round" />
          <path d="M1.4 10.6 L2 7.8 L4.2 10 Z" style={{ fill: PAPER, stroke: INK }} {...hair} strokeLinejoin="round" />
          <path d="M7.2 2.6 L9.4 4.8" style={{ stroke: INK }} strokeWidth="0.8" />
        </>
      );
    case 'flask': {
      const outline = 'M4.6 1.2 V4.8 L1.6 9.8 Q1.1 11 2.4 11 H9.6 Q10.9 11 10.4 9.8 L7.4 4.8 V1.2';
      return (
        <>
          <path d={outline} style={{ fill: PAPER }} />
          <path d="M3 7.6 H9 L10.4 9.8 Q10.9 11 9.6 11 H2.4 Q1.1 11 1.6 9.8 Z" style={{ fill: tone }} />
          <path d={outline} fill="none" style={{ stroke: INK }} {...hair} strokeLinejoin="round" />
          <path d="M3.8 1.2 H8.2" style={{ stroke: INK }} {...hair} strokeLinecap="round" />
          <circle cx="5.2" cy="9.3" r="0.75" style={{ fill: PAPER }} />
        </>
      );
    }
    case 'stopwatch':
      return (
        <>
          <path d="M6 0.8 V2.5 M4.6 0.8 H7.4" style={{ stroke: INK }} {...hair} strokeLinecap="round" />
          <circle cx="6" cy="7" r="4.4" style={{ fill: tone, stroke: INK }} {...hair} />
          <path d="M6 7 V4.3 M6 7 L8 8.2" style={{ stroke: PAPER }} strokeWidth="1.1" strokeLinecap="round" />
        </>
      );
    case 'docclock':
      return (
        <>
          <rect x="0.8" y="0.8" width="7.4" height="9.6" rx="1" style={{ fill: PAPER, stroke: INK }} {...hair} />
          <path d="M2.4 3.4 H6.6 M2.4 5.4 H6.6 M2.4 7.4 H4.6" style={{ stroke: INK }} strokeWidth="0.7" opacity="0.6" />
          <circle cx="8.6" cy="8.4" r="3" style={{ fill: tone, stroke: PAPER }} strokeWidth="0.8" />
          <path d="M8.6 8.4 V6.8 M8.6 8.4 L9.7 9" style={{ stroke: PAPER }} strokeWidth="0.8" strokeLinecap="round" />
        </>
      );
    case 'doc':
      return (
        <>
          <rect x="2" y="0.8" width="8" height="10.4" rx="1" style={{ fill: PAPER, stroke: INK }} {...hair} />
          <path d="M3.8 3.6 H8.2 M3.8 5.8 H8.2 M3.8 8 H6.4" style={{ stroke: tone }} strokeWidth="0.9" strokeLinecap="round" />
        </>
      );
    case 'bubble':
      return (
        <>
          <path d="M2.6 1 H9.4 A2.1 2.1 0 0 1 11.5 3.1 V7 A2.1 2.1 0 0 1 9.4 9.1 H5.4 L2.6 11.4 V9.1 A2.1 2.1 0 0 1 0.5 7 V3.1 A2.1 2.1 0 0 1 2.6 1 Z" style={{ fill: tone }} />
          <g style={{ fill: PAPER }}>
            <circle cx="3.6" cy="5.05" r="0.95" />
            <circle cx="6" cy="5.05" r="0.95" />
            <circle cx="8.4" cy="5.05" r="0.95" />
          </g>
        </>
      );
    case 'hourglass':
      return (
        <>
          <path d="M2.4 1 H9.6 L6 6 L9.6 11 H2.4 L6 6 Z" style={{ fill: PAPER, stroke: INK }} {...hair} strokeLinejoin="round" />
          <path d="M3.9 10.2 H8.1 L6 7.6 Z" style={{ fill: tone }} />
          <path d="M4.4 2.6 H7.6 L6 4.6 Z" style={{ fill: tone }} opacity="0.55" />
        </>
      );
    case 'tick':
      return (
        <>
          <circle cx="6" cy="6" r="5.2" style={{ fill: tone }} />
          <path d="M3.5 6.2 L5.2 7.9 L8.6 4.3" fill="none" style={{ stroke: PAPER }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case 'mug':
      return (
        <>
          <path d="M3.8 0.8 Q4.6 1.8 3.8 2.8 M6.4 0.8 Q7.2 1.8 6.4 2.8" fill="none" style={{ stroke: INK }} strokeWidth="0.8" strokeLinecap="round" opacity="0.55" />
          <path d="M8.8 6 H9.6 A1.5 1.5 0 0 1 9.6 9 H8.8" fill="none" style={{ stroke: INK }} {...hair} />
          <rect x="1.6" y="4.4" width="7.2" height="6.8" rx="1.4" style={{ fill: tone, stroke: INK }} {...hair} />
        </>
      );
    case 'zz':
      return (
        <g fill="none" style={{ stroke: tone }} strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 5.4 H5 L1 10.4 H5" strokeWidth="1.4" />
          <path d="M7 1.4 H10.4 L7 5.2 H10.4" strokeWidth="1.2" />
        </g>
      );
    case 'alert':
      return (
        <>
          <circle cx="6" cy="6" r="5.2" style={{ fill: tone }} />
          <rect x="5.2" y="2.6" width="1.6" height="4.6" rx="0.8" style={{ fill: PAPER }} />
          <circle cx="6" cy="9" r="0.95" style={{ fill: PAPER }} />
        </>
      );
    case 'boot':
      return (
        <>
          <circle cx="6" cy="6" r="4.4" fill="none" style={{ stroke: tone }} strokeWidth="1.4" strokeDasharray="2.2 1.8" strokeLinecap="round" />
          <circle cx="6" cy="6" r="1.4" style={{ fill: tone }} />
        </>
      );
    case 'plug':
      return (
        <>
          <path d="M0.6 6 H2.4" style={{ stroke: INK }} strokeWidth="1" strokeLinecap="round" />
          <rect x="2.4" y="3.6" width="4.2" height="4.8" rx="1" style={{ fill: PAPER, stroke: INK }} {...hair} />
          <path d="M6.6 4.8 H8.2 M6.6 7.2 H8.2" style={{ stroke: INK }} {...hair} strokeLinecap="round" />
          <path d="M10.6 2.8 V9.2" style={{ stroke: tone }} strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
  }
}

/** A drawing and the box it is drawn in. */
export interface CharacterDrawing {
  /** `x y width height`. */
  viewBox: string;
  drawing: ReactNode;
}

/** The prop group; a handed-off doc can be dropped (app.css). */
function PropAt({ transform, figure }: { transform: string; figure: Figure }) {
  return (
    <g className={figure.prop === 'doc' ? 'character-doc' : undefined} transform={transform}>
      {propDrawing(figure.prop, figure.tone)}
    </g>
  );
}

// -- Bean & Block: the board's robot, with limbs. -------------------------------------------------------------------

/** A limb: a line from `x1 y1` (hip or shoulder) to `x2 y2`. */
type Limb = readonly [x1: number, y1: number, x2: number, y2: number];

const STANDING: readonly Limb[] = [[13, 28, 13, 33], [19, 28, 19, 33]];
const ARMS_DOWN: readonly Limb[] = [[9, 19, 6, 24], [23, 19, 26, 24]];
const SEATED: readonly Limb[] = [[12, 28, 7, 30], [20, 28, 25, 30]];

/** What each stance moves. Any it doesn't name is standing, arms down, prop at the shoulder. */
const STANCES: Partial<Record<Stance, { legs?: readonly Limb[]; arms: readonly Limb[]; raise?: string; prop?: string }>> = {
  hold: { arms: [[9, 19, 6, 24], [23, 19, 25.5, 14]] },
  busy: { arms: [[9, 19, 5.5, 21], [23, 19, 26.5, 16.5]] },
  tilt: { arms: [[9, 19, 6, 24], [23, 19, 20, 23]], prop: 'translate(19 -1) scale(0.9)' },
  wave: { arms: [[9, 19, 6, 24], [23, 17, 28.5, 9]], prop: 'translate(-1 -1) scale(0.82)' },
  carry: { arms: [[9, 19, 19, 21.5], [23, 19, 24, 22]], prop: 'translate(18.5 15) scale(0.85)' },
  hop: { legs: [[13, 28, 12, 31.5], [19, 28, 20, 31.5]], arms: [[9, 18, 5, 13], [23, 18, 27, 13]], raise: 'translate(0 -3)', prop: 'translate(21.5 -3) scale(0.78)' },
  sit: { legs: SEATED, arms: [[9, 20, 6.5, 25], [23, 20, 25.5, 25]], raise: 'translate(0 2.5)', prop: 'translate(22 9) scale(0.82)' },
  sleep: { legs: SEATED, arms: [[9, 20, 7.5, 25], [23, 20, 24.5, 25]], raise: 'translate(0 2.5)', prop: 'translate(21 -1) scale(0.9)' },
};

/** The props that paint an element: `paint` if given, or the design's body colour. */
const paintedAs = (paint: string | undefined) => (paint === undefined ? { className: BODY_CLASS } : { style: { fill: paint } });

/** A bean or block's limbs, body and face, standing at ease with arms down unless told otherwise. */
export function BeanBody({ body, face = 'open', legs = STANDING, arms = ARMS_DOWN, paint }: { body: CharacterBody; face?: Face; legs?: readonly Limb[]; arms?: readonly Limb[]; paint?: string }) {
  const fill = paintedAs(paint);
  return (
    <>
      <path d={[...legs, ...arms].map(([x1, y1, x2, y2]) => `M${x1} ${y1}L${x2} ${y2}`).join('')} fill="none" style={{ stroke: INK }} strokeWidth="2" strokeLinecap="round" />
      {body === 'bean' ? (
        <path d="M16 8 C22.5 8 24.5 12.5 24 19 C23.5 25.5 21 29 16 29 C10.5 29 7.8 25.5 8 18.5 C8.2 12 10 8 16 8 Z" {...fill} />
      ) : (
        <rect x="8.5" y="8.5" width="15" height="20" rx="2.5" {...fill} />
      )}
      <BeanFace face={face} paint={paint} />
    </>
  );
}

/** A circle as path data, so a pair of them is one element. */
const circle = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

/** Both eyes, drawn in as few elements as a paint each: every tile on the board has them. */
function BeanFace({ face, paint }: { face: Face; paint: string | undefined }) {
  const at = [13, 19];
  const both = (draw: (x: number) => string) => at.map(draw).join('');
  const lines = (draw: (x: number) => string) => <path d={both(draw)} fill="none" style={{ stroke: PAPER }} strokeWidth="1.3" strokeLinecap="round" />;
  const eyes = (whiteY: number, whiteR: number, pupil: (x: number) => string) => (
    <>
      <path d={both((x) => circle(x, whiteY, whiteR))} style={{ fill: PAPER }} />
      <path d={both(pupil)} style={{ fill: INK }} />
    </>
  );
  switch (face) {
    case 'closed':
      return lines((x) => `M${x - 1.8} 15.4Q${x} 17.4 ${x + 1.8} 15.4`);
    case 'crossed':
      return lines((x) => `M${x - 1.6} 13.9L${x + 1.6} 17.1M${x + 1.6} 13.9L${x - 1.6} 17.1`);
    case 'happy':
      return lines((x) => `M${x - 1.8} 16.3Q${x} 13.6 ${x + 1.8} 16.3`);
    case 'blank':
      return lines((x) => `M${x - 1.2} 15.5H${x + 1.2}`);
    case 'focus':
    case 'half': {
      const lid = (face === 'focus' ? 14.9 : 15.6) - 12.8;
      return (
        <>
          {eyes(15.5, 2.3, (x) => circle(x, 16, 1.1))}
          <path d={both((x) => `M${x - 2.6} 12.8h5.2v${lid}h-5.2z`)} {...paintedAs(paint)} />
        </>
      );
    }
    case 'wide':
      return eyes(15.3, 2.8, (x) => circle(x, 15.3, 1.3));
    default: {
      const [dx, dy] = { ahead: [0.8, 0], side: [-0.8, 0.2], up: [0.3, -1], down: [0, 1] }[face as string] ?? [0, 0];
      return eyes(15.5, 2.3, (x) => circle(x + dx!, 15.5 + dy!, 1.1));
    }
  }
}

function drawBean(body: CharacterBody, pose: CharacterPose): CharacterDrawing {
  const figure = FIGURES[pose];
  const { legs, arms, raise, prop = 'translate(20 1) scale(0.95)' } = STANCES[figure.stance] ?? {};
  const figureTransform = figure.stance === 'topple' ? 'translate(0 7) rotate(90 16 22)' : raise;
  const bean = <BeanBody body={body} face={figure.face} legs={legs} arms={arms} />;
  return {
    viewBox: '0 0 32 36',
    drawing: (
      <>
        {figure.stance === 'busy' && (
          <g style={{ stroke: INK }} strokeWidth="1.2" strokeLinecap="round" opacity="0.45">
            <line x1="0.5" y1="15" x2="4" y2="15" />
            <line x1="0" y1="20" x2="4.5" y2="20" />
          </g>
        )}
        {figureTransform === undefined ? bean : <g transform={figureTransform}>{bean}</g>}
        <PropAt transform={prop} figure={figure} />
      </>
    ),
  };
}

// -- Pebble: limbless, posing by squash and stretch, with a floating prop and a ground shadow. --------------------------

const squash = (x: number, y: number) => `translate(16 28.5) scale(${x} ${y}) translate(-16 -28.5)`;

const PEBBLE_POSTURES: Partial<Record<Stance, string>> = {
  tilt: 'rotate(-10 16 28.5)',
  busy: 'translate(16 28.5) skewX(-9) scale(0.95 1.06) translate(-16 -28.5)',
  hold: squash(0.97, 1.03),
  wave: `rotate(8 16 28.5) ${squash(0.95, 1.06)}`,
  hop: 'translate(0 -3.6)',
  sit: squash(1.08, 0.88),
  sleep: squash(1.16, 0.72),
  topple: 'translate(0 -1.5) rotate(90 16 19.75)',
  carry: squash(0.97, 1.02),
};

function PebbleFace({ face }: { face: Face }) {
  const at = [12.4, 19.6];
  const capsules = (dx: number, y: number, height: number, width = 2.2) => (
    <g style={{ fill: EYE }}>
      {at.map((x) => (
        <rect key={x} x={x + dx - width / 2} y={y} width={width} height={height} rx={Math.min(width, height) / 2} />
      ))}
    </g>
  );
  const lines = (draw: (x: number) => string) => <path d={at.map(draw).join('')} fill="none" style={{ stroke: EYE }} strokeWidth="1.6" strokeLinecap="round" />;
  switch (face) {
    case 'up':
      return capsules(0.4, 15.4, 3.6);
    case 'ahead':
      return capsules(1.5, 17, 4.4);
    case 'side':
      return capsules(-1.4, 17.2, 4.2);
    case 'down':
      return capsules(0, 19.2, 3.2);
    case 'focus':
      return capsules(0, 19, 1.7, 3.4);
    case 'half':
      return capsules(0, 19.6, 2.2, 2.6);
    case 'wide':
      return (
        <>
          <path d={at.map((x) => circle(x, 19, 2.4)).join('')} style={{ fill: EYE }} />
          <path d={at.map((x) => circle(x + 0.8, 18.2, 0.7)).join('')} className={BODY_CLASS} />
        </>
      );
    case 'happy':
      return lines((x) => `M${x - 1.9} 20.2 Q${x} 17.2 ${x + 1.9} 20.2`);
    case 'closed':
      return lines((x) => `M${x - 1.9} 19 Q${x} 21.2 ${x + 1.9} 19`);
    case 'crossed':
      return lines((x) => `M${x - 1.6} 17.6 L${x + 1.6} 20.8 M${x + 1.6} 17.6 L${x - 1.6} 20.8`);
    case 'blank':
      return <path d={at.map((x) => circle(x, 19.4, 0.95)).join('')} style={{ fill: EYE }} opacity="0.7" />;
    default:
      return capsules(0, 17, 4.4);
  }
}

function drawPebble(body: CharacterBody, pose: CharacterPose): CharacterDrawing {
  const figure = FIGURES[pose];
  const { stance } = figure;
  return {
    viewBox: '0 0 32 32',
    drawing: (
      <>
        <ellipse cx="16" cy="29.8" rx={stance === 'hop' ? 7 : stance === 'topple' ? 9 : 10.5} ry="1.5" style={{ fill: INK }} opacity={stance === 'hop' ? 0.08 : 0.13} />
        <g transform={PEBBLE_POSTURES[stance]}>
          {body === 'bean' ? (
            <path d="M5 22 C5 14.5 9.5 11 16 11 C22.5 11 27 14.5 27 22 C27 26.5 23.5 28.5 16 28.5 C8.5 28.5 5 26.5 5 22 Z" className={BODY_CLASS} />
          ) : (
            <rect x="5" y="11.5" width="22" height="17" rx="5" className={BODY_CLASS} />
          )}
          <PebbleFace face={figure.face} />
        </g>
        <PropAt transform={stance === 'carry' ? 'translate(19.5 17) scale(0.85)' : 'translate(20.5 0) scale(0.9)'} figure={figure} />
      </>
    ),
  };
}

// -- Pixel: a 14 by 13 robot on a hard grid, with a 6 by 6 sprite prop. --------------------------------------------------

/** B body, D ink, E and W paper, S and P the board's colour for the pose. */
type PixelPaint = 'B' | 'D' | 'E' | 'W' | 'S' | 'P';

const SPRITES: Record<Prop, readonly string[]> = {
  dots: ['....PP', '....PP', '..P...', '......', 'P.....', '......'],
  gear: ['P.PP.P', '.PPPP.', 'PPWWPP', 'PPWWPP', '.PPPP.', 'P.PP.P'],
  book: ['......', 'WWDWW.', 'WPDPW.', 'WWDWW.', 'WPDPW.', 'DDDDD.'],
  pencil: ['....DD', '...PPD', '..PPP.', '.PPP..', 'WPP...', 'D.....'],
  flask: ['.DDDD.', '..WW..', '..WW..', '.WPPW.', 'WPPPPW', 'DDDDDD'],
  stopwatch: ['..DD..', '.PPPP.', 'PPWPPP', 'PPWWPP', 'PPPPPP', '.PPPP.'],
  docclock: ['WWWW..', 'WDDW..', 'WWWPP.', 'WDPWPP', 'WWPPPP', '...PP.'],
  doc: ['.WWWW.', '.WDDW.', '.WWWW.', '.WDDW.', '.WWWW.', '......'],
  bubble: ['PPPPPP', 'PPPPPP', 'PWPWPW', 'PPPPPP', '.PP...', '.P....'],
  hourglass: ['DDDDDD', '.WPPW.', '..PP..', '..WW..', '.WPPW.', 'DDDDDD'],
  tick: ['......', '.....P', '....PP', 'P..PP.', 'PPPP..', '.PP...'],
  mug: ['.D.D..', '......', 'PPPP..', 'PPPPD.', 'PPPPD.', 'PPPP..'],
  zz: ['...PPP', '....P.', '...PPP', 'PPP...', '.P....', 'PPP...'],
  alert: ['..PP..', '.PWWP.', '.PWWP.', 'PPWWPP', 'PPPPPP', 'PPWWPP'],
  boot: ['.P.P..', 'P....P', '......', 'P....P', '.P.P..', '......'],
  plug: ['......', 'DWWW..', 'DWWWDD', 'DWWW..', 'DWWWDD', '.....P'],
};

const GRID_WIDTH = 20;
const GRID_HEIGHT = 14;

/** The grid's cells for a pose, each a paint or empty. */
function pixelGrid(body: CharacterBody, pose: CharacterPose): (PixelPaint | '.')[][] {
  const { face, stance, prop } = FIGURES[pose];
  const grid: (PixelPaint | '.')[][] = Array.from({ length: GRID_HEIGHT }, () => Array<PixelPaint | '.'>(GRID_WIDTH).fill('.'));
  const put = (row: number, column: number, paint: PixelPaint) => {
    if (grid[row]?.[column] !== undefined) grid[row]![column] = paint;
  };
  // A grid robot on its side would be tall and narrow, unlike any other pose: it slumps where it stands instead.
  const slumped = stance === 'sit' || stance === 'sleep' || stance === 'topple';
  const dy = stance === 'hop' ? -1 : slumped ? 1 : 0;
  // Its antenna light goes out when it sleeps or its daemon went away.
  const lightOff = stance === 'sleep' || pose === 'stopped-by-restart';
  const corner = body === 'bean' ? '..BBBBBBBBBB..' : '.BBBBBBBBBBBB.';
  const robot = ['..............', '......SS......', '......DD......', corner, '.BBBBBBBBBBBB.', '.BDDDDDDDDDDB.', '.BDDDDDDDDDDB.', '.BDDDDDDDDDDB.', '.BDDDDDDDDDDB.', '.BBBBBBBBBBBB.', corner];
  robot.forEach((line, row) =>
    [...line].forEach((cell, column) => {
      if (cell !== '.') put(row + dy, column, cell === 'S' && lightOff ? 'D' : (cell as PixelPaint));
    }),
  );
  const paint = (cells: readonly (readonly [number, number])[], ink: PixelPaint = 'E') => cells.forEach(([row, column]) => put(row + dy, column, ink));
  const pair = (rows: readonly number[], columns: readonly number[]) => rows.flatMap((row) => columns.map((column) => [row, column] as const));
  const EYES = [3, 4, 9, 10];
  switch (face) {
    case 'up':
      paint(pair([5, 6], EYES));
      break;
    case 'ahead':
      paint(pair([6, 7], [4, 5, 10, 11]));
      break;
    case 'side':
      paint(pair([6, 7], [2, 3, 8, 9]));
      break;
    case 'down':
      paint(pair([7, 8], EYES));
      break;
    case 'focus':
      paint(pair([7], EYES));
      paint([[6, 4], [6, 10]]);
      break;
    case 'wide':
      paint(pair([5, 6, 7, 8], EYES));
      break;
    case 'happy':
      paint([[6, 4], [6, 9], [7, 3], [7, 5], [7, 8], [7, 10]]);
      break;
    case 'half':
      paint(pair([7], EYES), 'B');
      paint(pair([8], EYES));
      break;
    case 'closed':
      paint(pair([8], EYES));
      break;
    case 'crossed':
      paint([[5, 3], [5, 5], [6, 4], [7, 3], [7, 5], [5, 8], [5, 10], [6, 9], [7, 8], [7, 10]], 'S');
      break;
    case 'blank':
      paint([[7, 3], [7, 9]]);
      break;
    default:
      paint(pair([6, 7], EYES));
  }
  const LEG_COLUMNS = [3, 4, 9, 10];
  if (stance === 'busy') {
    paint(pair([11], LEG_COLUMNS), 'B');
    paint(pair([12], [2, 3, 10, 11]), 'D');
  } else if (stance === 'hop') {
    paint(pair([11], LEG_COLUMNS), 'D');
  } else if (!slumped) {
    pair([11], LEG_COLUMNS).forEach(([row, column]) => put(row, column, 'B'));
    pair([12], LEG_COLUMNS).forEach(([row, column]) => put(row, column, 'D'));
  }
  if (stance === 'wave') paint([[2, 13], [3, 13], [4, 13], [5, 13]], 'B');
  if (stance === 'hold') paint([[7, 13], [6, 13]], 'B');
  if (stance === 'carry') paint([[8, 13]], 'B');
  const [propRow, propColumn] = stance === 'carry' ? [6, 14] : slumped ? [2, 14] : [0, 14];
  SPRITES[prop].forEach((line, row) =>
    [...line].forEach((cell, column) => {
      if (cell !== '.') put(propRow + row, propColumn + column, cell as PixelPaint);
    }),
  );
  return grid;
}

function drawPixel(body: CharacterBody, pose: CharacterPose): CharacterDrawing {
  const { tone } = FIGURES[pose];
  // One path per paint, whatever the pose: a grid's worth of rects would be the costliest drawing on the board.
  const runs = new Map<PixelPaint, string>();
  pixelGrid(body, pose).forEach((line, row) => {
    for (let column = 0; column < GRID_WIDTH; ) {
      const paint = line[column]!;
      let run = 1;
      while (line[column + run] === paint) run++;
      if (paint !== '.') runs.set(paint, `${runs.get(paint) ?? ''}M${column} ${row}h${run}v1h-${run}z`);
      column += run;
    }
  });
  const paints: Record<Exclude<PixelPaint, 'B'>, string> = { D: INK, E: PAPER, W: PAPER, S: tone, P: tone };
  return {
    viewBox: '0 -2 20 16',
    drawing: (
      <g shapeRendering="crispEdges">
        {[...runs].map(([paint, d]) => (
          <path key={paint} d={d} {...paintedAs(paint === 'B' ? undefined : paints[paint])} />
        ))}
      </g>
    ),
  };
}

const DRAWERS: Record<DrawnStyle, (body: CharacterBody, pose: CharacterPose) => CharacterDrawing> = { bean: drawBean, pebble: drawPebble, pixel: drawPixel };

const drawn = new Map<string, CharacterDrawing>();

/** A pose in a style and body, made the first time it is asked for and the same elements from then on. */
export function characterDrawing(style: DrawnStyle, body: CharacterBody, pose: CharacterPose): CharacterDrawing {
  const key = `${style}/${body}/${pose}`;
  let drawing = drawn.get(key);
  if (drawing === undefined) {
    drawing = DRAWERS[style](body, pose);
    drawn.set(key, drawing);
  }
  return drawing;
}

/** A Pixel character's height in px: its 16-row box at a whole number of device pixels on a Retina screen, so it never blurs. */
export function pixelSnapped(height: number): number {
  return Math.max(16, Math.round(height / 8) * 8);
}
