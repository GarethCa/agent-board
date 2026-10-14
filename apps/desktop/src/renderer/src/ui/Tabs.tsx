import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';

export interface Tab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** A small figure after the label, such as how many there are. */
  count?: ReactNode;
}

interface TabsProps<T extends string> {
  tabs: readonly Tab<T>[];
  value: T;
  onChange(value: T): void;
  'aria-label': string;
  className?: string;
}

/**
 * A row of tabs: one is picked, and shows its panel. The picked one is the row's one stop in the tab order; the
 * arrows, Home and End move to another and pick it.
 */
export function Tabs<T extends string>({ tabs, value, onChange, className, ...rest }: TabsProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const next =
      event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(tabs[next]!.id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div ref={list} className={cx('ui-tabs', className)} role="tablist" aria-label={rest['aria-label']} onKeyDown={move}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="ui-tab"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon}
          {tab.label}
          {tab.count !== undefined && <span className="ui-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
