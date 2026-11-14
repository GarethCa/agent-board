import { ReadingView } from './ReadingView';
import { REVIEW } from './reading-fixture';

const TITLE = 'Review of the interface size change (PR #578), round 1';

/** The views of a long document for the visual shots: wide with its rail, at the top and at its findings, and narrow. */
const FRAMES = [
  { name: 'wide-top', width: 980, height: 640 },
  { name: 'wide-findings', width: 980, height: 640 },
  { name: 'narrow', width: 600, height: 640 },
];

export function ReadingGallery() {
  return (
    <section data-testid="reading-gallery" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      {FRAMES.map(({ name, width, height }) => (
        <div key={name} data-testid={`reading-${name}`} style={{ display: 'flex', width, height }}>
          <ReadingView text={REVIEW} title={TITLE} path={`gallery:${name}`} onOpenLink={() => {}} />
        </div>
      ))}
    </section>
  );
}
