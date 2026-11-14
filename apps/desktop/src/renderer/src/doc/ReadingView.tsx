import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Markdown } from '../session/Markdown';
import { findKeyIsFor } from '../find/use-find';
import { binding, isActive, keyText, pressed } from '../keys/registry';
import {
  DECISION_ID,
  findingsLine,
  findingsOf,
  placeKey,
  placeOf,
  railShown,
  readingOf,
  severityLine,
  spy,
  timeLeft,
  type Decision,
  type Mark,
  type Place,
  type Spy,
} from './reading';
import type { Outline } from './remark-findings';
import './reading.css';

/** What the tab's head shows of the reader's progress: the time left, and Back to the top once scrolled. */
export interface ReadingStatus {
  label: string;
  scrolled: boolean;
  toTop(): void;
}

interface ReadingViewProps {
  /** The document, as Markdown. */
  text: string;
  /** What the head calls it: a first heading the same is left out. */
  title?: string;
  /** Where the reader's place is kept. */
  path: string;
  onOpenLink(url: string): void;
  /** Told when the time left changes, or the reader leaves or comes back to the top. */
  onStatus?(status: ReadingStatus): void;
  /** On the scrolled part, for find and tests. */
  testId?: string;
  current?: boolean;
}

const NO_SPY: Spy = { current: DECISION_ID, section: DECISION_ID, passed: new Set() };
/** How far down an element starts in what scrolls it. */
const topIn = (scroller: HTMLElement, element: Element) => element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
const sameSpy = (a: Spy, b: Spy) => a.current === b.current && a.section === b.section && a.passed.size === b.passed.size && [...a.passed].every((id) => b.passed.has(id));

/** Which section each mark is in, for scroll-spy: a section is in itself, a finding in the section above it. */
function sectionsOf(outline: Outline): Map<string, string> {
  const of = new Map<string, string>();
  for (const finding of outline.leading) of.set(finding.id, DECISION_ID);
  for (const section of outline.sections) {
    of.set(section.id, section.id);
    for (const finding of section.findings) of.set(finding.id, section.id);
  }
  return of;
}

/**
 * A long Markdown document to read: one 68-character column with the decision lifted to its top, findings folded to
 * their headlines, and at the left a rail of its sections and findings that marks where the reader is. The rail hides
 * in a narrow pane; ⌘\ shows or hides it. The reader's place (how far down, which findings are open) is kept by path.
 */
export function ReadingView({ text, title, path, onOpenLink, onStatus, testId, current }: ReadingViewProps) {
  const reading = useMemo(() => readingOf(text, title), [text, title]);
  const findings = useMemo(() => findingsOf(reading.outline), [reading]);
  const sections = useMemo(() => sectionsOf(reading.outline), [reading]);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const [override, setOverride] = useState<boolean>();
  const [at, setAt] = useState<Spy>(NO_SPY);
  const [percent, setPercent] = useState(0);
  const [label, setLabel] = useState(() => timeLeft(reading.words, 0));
  const [scrolled, setScrolled] = useState(false);
  const shown = railShown(width, override);

  const toTop = useCallback(() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }), []);
  const jump = useCallback((id: string) => {
    const box = scroller.current;
    if (!box) return;
    if (id === DECISION_ID) return box.scrollTo({ top: 0, behavior: 'smooth' });
    const target = box.querySelector(`#${CSS.escape(id)}`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    if (target) box.scrollTo({ top: Math.max(0, topIn(box, target) - 16), behavior: 'smooth' });
  }, []);

  // The width decides whether the rail shows: read before the first paint, so a narrow pane never flashes it.
  useLayoutEffect(() => {
    const element = root.current;
    if (element) setWidth(element.getBoundingClientRect().width);
  }, []);

  const overrideRef = useRef(override);
  overrideRef.current = override;
  // ⌘\ in the document shows or hides the rail, before the board's menu can take it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = root.current;
      if (!element || !pressed('window.readingRail', event) || !findKeyIsFor(element, event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOverride(!railShown(element.getBoundingClientRect().width, overrideRef.current));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Progress and scroll-spy, a frame at a time.
  const measure = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const max = box.scrollHeight - box.clientHeight;
    const fraction = max > 0 ? Math.min(1, box.scrollTop / max) : 0;
    root.current?.style.setProperty('--read-fraction', String(fraction));
    setPercent(Math.round(fraction * 100));
    setLabel(timeLeft(reading.words, fraction));
    setScrolled(box.scrollTop > 0);
    const marks: Mark[] = [{ id: DECISION_ID, section: DECISION_ID, top: 0 }];
    for (const element of box.querySelectorAll('.doc-read > :is(h1, h2)[id], details.finding[id]')) {
      const section = sections.get(element.id);
      if (section !== undefined) marks.push({ id: element.id, section, top: topIn(box, element) });
    }
    marks.sort((a, b) => a.top - b.top);
    const next = spy(marks, box.scrollTop, max > 0 && box.scrollTop >= max - 4);
    setAt((previous) => (sameSpy(previous, next) ? previous : next));
  }, [reading, sections]);

  // The kept place: back to it when the document first shows, kept as the reader scrolls and opens findings. A tab
  // mounted behind another has no height: it goes back when it first shows.
  const restored = useRef<string | undefined>(undefined);
  const restore = useCallback(() => {
    const box = scroller.current;
    if (!box || restored.current === path || box.clientHeight === 0) return;
    restored.current = path;
    const place = placeOf(readStored(placeKey(path)));
    if (place) {
      for (const id of place.open) {
        const finding = box.querySelector(`#${CSS.escape(id)}`);
        if (finding instanceof HTMLDetailsElement) finding.open = true;
      }
      box.scrollTop = place.top;
      // A pane still being laid out may be too short to scroll that far yet: try again for a few frames.
      let tries = 0;
      const again = () => {
        if (!box.isConnected || box.scrollTop >= place.top - 1 || ++tries > 30) return;
        box.scrollTop = place.top;
        requestAnimationFrame(again);
      };
      requestAnimationFrame(again);
    }
    measure();
  }, [path, measure]);
  useLayoutEffect(restore, [restore]);

  // A new size: the rail may show or hide, a hidden tab may have just shown, and the marks have moved.
  const resized = useRef(() => {});
  resized.current = () => {
    restore();
    measure();
  };
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
      resized.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let frame = 0;
    let saving: ReturnType<typeof setTimeout> | undefined;
    // Taken as the reader scrolls: by the time this effect is cleaned up the scroller is out of the page, and reads 0.
    let place: Place | undefined;
    const save = () => {
      saving = undefined;
      if (place) writeStored(placeKey(path), JSON.stringify(place));
    };
    const onScroll = () => {
      // A hidden pane reads 0: that is not where the reader left it.
      if (box.clientHeight === 0) return;
      const open = [...box.querySelectorAll<HTMLDetailsElement>('details.finding[open]')].map((finding) => finding.id);
      place = { top: box.scrollTop, open };
      if (frame === 0)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      clearTimeout(saving);
      saving = setTimeout(save, 300);
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    box.addEventListener('toggle', onScroll, true);
    return () => {
      box.removeEventListener('scroll', onScroll);
      box.removeEventListener('toggle', onScroll, true);
      cancelAnimationFrame(frame);
      if (saving !== undefined) {
        clearTimeout(saving);
        save();
      }
    };
  }, [path, measure]);

  useEffect(() => {
    onStatus?.({ label, scrolled, toTop });
  }, [label, scrolled, toTop, onStatus]);

  const railText = useMemo(() => severityLine(findings), [findings]);
  const railKey = isActive(binding('window.readingRail'));
  return (
    <div className="read-view" ref={root} data-rail={shown || undefined} style={{ '--read-fraction': 0 } as CSSProperties}>
      <div className="read-progress" aria-hidden>
        <i />
      </div>
      <div className="read-body">
        {shown && (
          <nav className="read-rail" aria-label="On this page" data-testid="reading-rail">
            <div className="read-meter">
              <div className="read-meter-top">
                <span>
                  <b>{percent}%</b> read
                </span>
                <span>{label}</span>
              </div>
              <div className="read-bar">
                <i />
              </div>
            </div>
            <ul className="read-list">
              {reading.decision && <RailItem id={DECISION_ID} title="The decision" at={at} onJump={jump} />}
              {reading.outline.leading.length > 0 && <FindingItems findings={reading.outline.leading} at={at} onJump={jump} />}
              {reading.outline.sections.map((section) => (
                <RailItem key={section.id} id={section.id} title={section.title} at={at} onJump={jump} onTop={section.id === reading.decision?.from?.id}>
                  {section.findings.length > 0 && <FindingItems findings={section.findings} at={at} onJump={jump} />}
                </RailItem>
              ))}
            </ul>
            <div className="read-rail-foot">
              {railText}
              {railText !== '' && railKey && <br />}
              {railKey && (
                <>
                  <kbd>{keyText('window.readingRail')}</kbd> hides the rail
                </>
              )}
            </div>
          </nav>
        )}
        <div className="read-scroll" ref={scroller} tabIndex={0} data-testid={testId} data-current={current || undefined}>
          <article className="read-col">
            {reading.decision && <DecisionCard decision={reading.decision} line={findingsLine(findings)} words={reading.words} onJump={jump} onOpenLink={onOpenLink} />}
            <Markdown text={reading.body} onOpenLink={onOpenLink} variant="read" />
          </article>
        </div>
      </div>
    </div>
  );
}

interface RailItemProps {
  id: string;
  title: string;
  at: Spy;
  onJump(id: string): void;
  /** It is the section the decision card came from. */
  onTop?: boolean;
  children?: ReactNode;
}

function RailItem({ id, title, at, onJump, onTop, children }: RailItemProps) {
  return (
    <li>
      <button type="button" className="read-item" aria-current={at.current === id ? 'location' : undefined} data-read={at.passed.has(id) || undefined} onClick={() => onJump(id)}>
        <span className="read-mark" aria-hidden />
        <span>
          {title}
          {onTop && <span className="read-up">↑ on top</span>}
        </span>
      </button>
      {children}
    </li>
  );
}

function FindingItems({ findings, at, onJump }: { findings: ReturnType<typeof findingsOf>; at: Spy; onJump(id: string): void }) {
  return (
    <ul className="read-sub">
      {findings.map((finding) => (
        <li key={finding.id}>
          <button
            type="button"
            className="read-item"
            title={finding.headline}
            aria-current={at.current === finding.id ? 'location' : undefined}
            data-read={at.passed.has(finding.id) || undefined}
            onClick={() => onJump(finding.id)}
          >
            <span className="read-dot" data-sev={finding.severity} aria-label={finding.severity} />
            <span className="read-item-text">{finding.headline}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface DecisionCardProps {
  decision: Decision;
  line: string;
  words: number;
  onJump(id: string): void;
  onOpenLink(url: string): void;
}

/** The top of the column: the verdict and the part written for the reader, as the document has them. */
function DecisionCard({ decision, line, words, onJump, onOpenLink }: DecisionCardProps) {
  const { verdict, body, from } = decision;
  const time = [timeLeft(words, 0), line].filter((part) => part !== '').join(' · ');
  return (
    <section className="read-decision" id={DECISION_ID} aria-label="The decision">
      <div className="read-decision-top">
        <span className="eyebrow">The decision</span>
        {verdict && (
          <span className="read-verdict" data-tone={verdict.tone}>
            {verdict.label}
          </span>
        )}
        <span className="read-decision-time">{time}</span>
      </div>
      {body !== undefined && <Markdown text={body} onOpenLink={onOpenLink} variant="card" />}
      <div className="read-decision-src">
        <span>{sourceOf(decision)}</span>
        {from && (
          <a
            href={`#${from.id}`}
            onClick={(event) => {
              event.preventDefault();
              onJump(from.id);
            }}
          >
            Jump to it ↓
          </a>
        )}
      </div>
    </section>
  );
}

/** Where the card's words came from, so it is plain they are the document's own. */
function sourceOf({ verdict, from }: Decision): string {
  if (from) return `From ${verdict ? 'the document’s first line and ' : ''}its “${from.title}” section.`;
  return 'From the document’s first line.';
}

/** Renderer storage, which a locked-down window may not have. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Without storage the place is simply not kept.
  }
}
