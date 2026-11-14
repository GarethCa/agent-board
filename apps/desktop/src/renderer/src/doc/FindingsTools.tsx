import { useEffect, useRef, useState } from 'react';

/** The folded findings after this line: are they all open? */
const findingsAfter = (tools: HTMLElement | null): HTMLDetailsElement[] =>
  tools?.nextElementSibling ? [...tools.nextElementSibling.querySelectorAll<HTMLDetailsElement>(':scope > details.finding')] : [];

/** The line above a document's folded findings: how many there are, and Open all (or, all open, Fold all). */
export function FindingsTools({ count }: { count: number }) {
  const line = useRef<HTMLDivElement>(null);
  const [allOpen, setAllOpen] = useState(false);
  useEffect(() => {
    const list = line.current?.nextElementSibling;
    if (!list) return;
    const sync = () => setAllOpen(findingsAfter(line.current).every((finding) => finding.open));
    // A finding's toggle doesn't bubble: listen as it passes down.
    list.addEventListener('toggle', sync, true);
    return () => list.removeEventListener('toggle', sync, true);
  }, []);
  return (
    <div className="findings-tools" ref={line}>
      <span>
        {count} {count === 1 ? 'finding, folded to its headline.' : 'findings, folded to their headlines.'}
      </span>
      <button
        type="button"
        onClick={() => {
          const open = !allOpen;
          for (const finding of findingsAfter(line.current)) finding.open = open;
          setAllOpen(open);
        }}
      >
        {allOpen ? 'Fold all' : 'Open all'}
      </button>
    </div>
  );
}
