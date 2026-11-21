import { useState, type MouseEvent } from 'react';
import { Play } from 'lucide-react';
import { Button } from '../ui';
import { cx } from '../ui/cx';

const stopPropagation = (event: MouseEvent) => event.stopPropagation();

/**
 * The board's Wake button: an asleep, done or exited agent starts again in its conversation, a scheduled one runs now,
 * and a session a restart stopped resumes. Pressed once, it waits for that to land or fail. `onHover`: shown only while
 * its tile is hovered or holds the focus.
 */
export function WakeButton({
  label,
  hint,
  onWake,
  onHover = false,
  className,
  testId = 'wake',
}: {
  label: string;
  hint: string;
  onWake(): Promise<unknown>;
  onHover?: boolean;
  className?: string;
  testId?: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="xs"
      icon={<Play />}
      className={cx('nodrag', className)}
      data-testid={testId}
      data-on-hover={onHover || undefined}
      title={hint}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void onWake().finally(() => setPending(false));
      }}
      onDoubleClick={stopPropagation}
    >
      {label}
    </Button>
  );
}
