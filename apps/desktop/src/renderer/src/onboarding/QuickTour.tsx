import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, Bell, Menu as MenuIcon, MousePointerClick, Plus, SquareDashedMousePointer } from 'lucide-react';
import { keyText } from '../keys/registry';
import { Button, Kbd } from '../ui';
import type { Rect } from '../geometry';
import { placeCallout } from './first-run';

interface TourStop {
  /** What the spotlight is on: an element of the board's chrome, by selector. */
  target: string;
  icon: ReactNode;
  /** The small caps over the heading, and the key that goes with it. */
  eyebrow: string;
  keys?: string;
  title: string;
  body: ReactNode;
}

/** The tour's stops (mock Z): adding a zone, starting an agent, the needs-you inbox, expanding a tile, and the keys. */
const STOPS: TourStop[] = [
  {
    target: '[data-tour="board-menu"]',
    icon: <MenuIcon />,
    eyebrow: 'Board menu',
    keys: keyText('move.boardMenu'),
    title: 'Your zones, agents and settings',
    body: (
      <>
        Every zone and session is listed here, with the settings. Press <b>{keyText('move.spotlight')}</b> anywhere to jump to one by name.
      </>
    ),
  },
  {
    target: '[data-tour="add-zone"]',
    icon: <SquareDashedMousePointer />,
    eyebrow: 'Add zone',
    title: 'Add a zone: a group, or one for a repo',
    body: `Press ${keyText('make.zone')} and drag out where it goes. It starts as a group; bind it to a GitHub repo, a Linear team or a recent folder now or later, and it can follow its GitHub or Linear issues.`,
  },
  {
    target: '[data-tour="needs-you"]',
    icon: <Bell />,
    eyebrow: 'Needs you',
    title: 'Agents waiting on you collect here',
    body: 'Questions and permission prompts from every agent land in this inbox. Answer them without opening the agent.',
  },
  {
    target: '[data-testid="agent-tile"], .hybrid-tile',
    icon: <MousePointerClick />,
    eyebrow: 'Tiles',
    title: 'Double-click a tile to open it',
    body: 'Each session is a tile. Double-click one to open its terminal beside its details in a window, or drag it anywhere on the board. A single click just selects it.',
  },
  {
    target: '[data-tour="new-agent"]',
    icon: <Plus />,
    eyebrow: 'New agent',
    title: 'Start an agent, and the keys to know',
    body: (
      <>
        Press <Kbd>{keyText('make.agent')}</Kbd> and click to start Claude Code or Codex there, in a zone or anywhere on the board;{' '}
        <Kbd>{keyText('make.shell')}</Kbd> does the same for a shell. On the board: <Kbd>{keyText('make.note')}</Kbd> note,{' '}
        <Kbd>{keyText('make.text')}</Kbd> text, <Kbd>{keyText('make.shape')}</Kbd> shape (<Kbd>{keyText('make.insert')}</Kbd> finds one by
        name), <Kbd>{keyText('move.select')}</Kbd> select, <Kbd>{keyText('move.hand')}</Kbd> pan.
      </>
    ),
  },
];

/** Room round the spotlit element. */
const SPOT_PADDING = 8;

/**
 * Onboarding's quick tour (mock Z): coach marks over the real board, each a spotlight on one part of the chrome and a
 * callout beside it. A stop whose element isn't on the board (no tile yet) shows its callout in the middle.
 */
export function QuickTour({ progress, onBack, onDone }: { progress: ReactNode; onBack(): void; onDone(): void }) {
  const [at, setAt] = useState(0);
  const stop = STOPS[at]!;
  const callout = useRef<HTMLElement>(null);
  const [target, setTarget] = useState<Rect>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  useLayoutEffect(() => {
    const measure = () => {
      const found = document.querySelector(stop.target)?.getBoundingClientRect();
      setTarget(found === undefined ? undefined : { x: found.x, y: found.y, width: found.width, height: found.height });
      const box = callout.current?.getBoundingClientRect();
      if (box !== undefined) setSize({ width: box.width, height: box.height });
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [stop]);

  const place = placeCallout(target, viewport, size);
  const spot =
    target === undefined
      ? undefined
      : { left: target.x - SPOT_PADDING, top: target.y - SPOT_PADDING, width: target.width + 2 * SPOT_PADDING, height: target.height + 2 * SPOT_PADDING };
  const last = at === STOPS.length - 1;

  return (
    <div className="tour" data-testid="tour" data-stop={at + 1} data-onboarding-root>
      {/* The ring's shadow dims everything round it; with nothing to spotlight, a plain scrim does. */}
      {spot === undefined ? <div className="tour-scrim" aria-hidden /> : <div className="tour-ring" style={spot} aria-hidden />}
      <section
        ref={callout}
        className="tour-callout"
        data-side={place.side}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        style={{ left: place.left, top: place.top, '--beak': place.beak === undefined ? undefined : `${place.beak}px` } as CSSProperties}
      >
        {place.beak !== undefined && <span className="tour-beak" aria-hidden />}
        <div className="tour-head">
          <span className="tour-icon">{stop.icon}</span>
          <div>
            <div className="tour-eyebrow">
              {stop.eyebrow}
              {stop.keys !== undefined && <Kbd>{stop.keys}</Kbd>}
            </div>
            <h2 id="tour-title" className="tour-title">
              {stop.title}
            </h2>
          </div>
        </div>
        <p className="tour-body">{stop.body}</p>
        <div className="tour-foot">
          <div className="tour-dots" role="img" aria-label={`Tour step ${at + 1} of ${STOPS.length}`}>
            {STOPS.map((each, index) => (
              <span key={each.target} className="tour-dot" data-state={index < at ? 'done' : index === at ? 'current' : 'todo'} />
            ))}
          </div>
          <span className="tour-count">
            {at + 1} of {STOPS.length}
          </span>
          <span className="onboarding-foot-gap" />
          <Button size="sm" variant="ghost" onClick={() => (at === 0 ? onBack() : setAt(at - 1))}>
            Back
          </Button>
          <Button size="sm" variant="primary" trailingIcon={<ArrowRight />} onClick={() => (last ? onDone() : setAt(at + 1))} autoFocus>
            {last ? 'Finish' : 'Next'}
          </Button>
        </div>
      </section>
      <div className="tour-bar">
        {progress}
        <Button size="sm" variant="ghost" onClick={onDone}>
          Skip tour
          <Kbd>{keyText('dialog.close')}</Kbd>
        </Button>
      </div>
    </div>
  );
}
