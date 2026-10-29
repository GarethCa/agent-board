import { useEffect, useState } from 'react';
import type { UsageReading } from '@agent-board/daemon/protocol';
import { IslandSeparator, Tooltip } from '../ui';
import { cx } from '../ui/cx';
import { usageMeter, type UsageMeter } from './usage-view';

/** How often the pill's "read N min ago" is worked out again. */
const TICK_MS = 30_000;

/** The newest plan usage reading, kept up to date, and the time now, moving on every `TICK_MS`. */
export function useUsage(): { reading: UsageReading | undefined; now: number } {
  const [reading, setReading] = useState<UsageReading>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    window.agentBoard.orchestrators.usage().then(
      (first) => live && setReading(first),
      () => {},
    );
    const off = window.agentBoard.orchestrators.onUsage((event) => {
      setReading(event.usage);
      setNow(Date.now());
    });
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      live = false;
      off();
      clearInterval(timer);
    };
  }, []);
  return { reading, now };
}

/**
 * The 5-hour and weekly usage beside the zoom controls, when Settings › Usage turns it on: a small meter for each, with when each resets and how old
 * the reading is on hover. Nothing shows before a Claude agent's status line has posted a reading; a stale one is
 * hatched and says so. `separated` draws the island's divider after it, only when it draws itself.
 */
export function UsagePill({ separated = false }: { separated?: boolean }) {
  const { reading, now } = useUsage();
  const meter = reading === undefined ? undefined : usageMeter(reading, now);
  if (meter === undefined || meter.windows.length === 0) return null;
  const detail = <UsageDetail meter={meter} />;
  return (
    <>
      <Tooltip content={detail} side="top">
        <button
          type="button"
          className={cx('usage-pill', meter.hot && 'is-hot', meter.stale && 'is-stale')}
          aria-label={`Plan usage: ${meter.windows.map((window) => `${window.label} ${window.used}%`).join(', ')}${meter.stale ? ', stale' : ''}`}
          data-testid="usage-pill"
        >
          {meter.windows.map((window) => (
            <span key={window.short} className="usage-pill-window">
              <em>{window.short}</em>
              <UsageBar used={window.used} window={window.short} />
              {window.used}%
            </span>
          ))}
          {meter.stale && <span className="usage-pill-stale">stale</span>}
        </button>
      </Tooltip>
      {separated && <IslandSeparator />}
    </>
  );
}

/** The meter's figures: each window's use, what is left and when it resets, and how old the reading is. */
export function UsageDetail({ meter }: { meter: UsageMeter }) {
  return (
    <span className={cx('usage-detail', meter.stale && 'is-stale')}>
      {meter.windows.map((window) => (
        <span key={window.short} className="usage-detail-window">
          <span className="usage-detail-head">
            {window.label} <span>{window.used}%</span>
          </span>
          {!meter.stale && <UsageBar used={window.used} window={window.short} wide />}
          <span className="usage-detail-foot">
            <span>{window.left}% left</span>
            <span>{window.resets}</span>
          </span>
        </span>
      ))}
      <span className="usage-detail-fresh">{meter.fresh}</span>
    </span>
  );
}

function UsageBar({ used, window, wide = false }: { used: number; window: string; wide?: boolean }) {
  return (
    <span className={cx('usage-bar', `usage-bar-${window}`, wide && 'is-wide')} aria-hidden>
      <i style={{ width: `${Math.min(100, used)}%` }} />
    </span>
  );
}
