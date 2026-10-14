import { useRef, useState, type ElementType, type KeyboardEvent } from 'react';
import { Pencil } from 'lucide-react';
import { MAX_NAME_LENGTH } from '@agent-board/daemon/protocol';
import { IconButton } from './Button';
import { Input } from './Field';
import { errorMessage } from '../../../shared/errors';
import { cx } from './cx';

/** One name being renamed in place: whether the field is open, and how it saves. */
export interface Renaming {
  editing: boolean;
  /** Why the last save failed, until the next try; undefined otherwise. */
  problem: string | undefined;
  start(): void;
  /** Starts once a menu that asked has given the focus back to its button, which would close the field at once. */
  startSoon(): void;
  /** Saves `name` and closes the field. A blank or unchanged name only closes it (unless blank is `allowBlank`). */
  commit(name: string): void;
  cancel(): void;
}

/** A menu hands the focus back to its button a tick after it closes: longer than that, then open the field. */
export const MENU_FOCUS_RETURN_MS = 80;

/**
 * The state of a name that can be renamed in place. `save` takes the new, trimmed name; if it rejects, the
 * name stays as it was and the name shows `problem` (a window with no board to report to has nowhere else to say it). With `allowBlank`, a blank name is saved as `''`, to
 * clear an optional label; otherwise it reverts.
 */
export function useRenaming(current: string, save: (name: string) => unknown, allowBlank = false): Renaming {
  const [editing, setEditing] = useState(false);
  // Enter and then the blur it causes must save once.
  const done = useRef(false);
  const [problem, setProblem] = useState<string>();
  const start = () => {
    done.current = false;
    setProblem(undefined);
    setEditing(true);
  };
  return {
    editing,
    problem,
    start,
    startSoon: () => void setTimeout(start, MENU_FOCUS_RETURN_MS),
    commit(name) {
      if (done.current) return;
      done.current = true;
      setEditing(false);
      const trimmed = name.trim();
      if (trimmed === current.trim() || (trimmed === '' && !allowBlank)) return;
      void Promise.resolve(save(trimmed)).catch((error: unknown) => setProblem(`Could not rename: ${errorMessage(error)}`));
    },
    cancel() {
      done.current = true;
      setEditing(false);
    },
  };
}

interface EditableNameProps {
  /** The name shown, and the field's starting text. */
  value: string;
  renaming: Renaming;
  /** The element that shows the name. */
  as?: ElementType;
  className?: string;
  title?: string;
  /** What shows in place of `value` when it isn't all the name (a reviewer's subtitle is split off); `value` is then its tooltip. */
  shown?: string;
  /** What the field says it is, to assistive tech. */
  label: string;
  /** What the field starts with, when it should not be `value` (a pane label starts empty when it has none). */
  initial?: string;
  placeholder?: string;
}

/**
 * A name that becomes a field on a double-click (or when its `renaming` is started, by a pencil button, F2 or a menu).
 * Enter or blur saves, Escape cancels. Capped to `MAX_NAME_LENGTH`.
 */
export function EditableName({ value, renaming, as: Tag = 'span', className, title, shown = value, label, initial = value, placeholder }: EditableNameProps) {
  if (renaming.editing) {
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      // Not for the board or the window behind: Escape closes the field only, and letters are just letters.
      event.stopPropagation();
      if (event.key === 'Enter') renaming.commit(event.currentTarget.value);
      else if (event.key === 'Escape') renaming.cancel();
    };
    return (
      <Input
        autoFocus
        size="sm"
        className={cx('editable-name-field nodrag nopan nowheel', className)}
        aria-label={label}
        data-testid="rename-field"
        defaultValue={initial}
        maxLength={MAX_NAME_LENGTH}
        placeholder={placeholder}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onKeyDown}
        onBlur={(event) => renaming.commit(event.currentTarget.value)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    );
  }
  return (
    <Tag
      className={cx('editable-name', className)}
      title={renaming.problem ?? title ?? (shown === value ? undefined : value)}
      data-problem={renaming.problem !== undefined || undefined}
      onDoubleClick={(event: { stopPropagation(): void }) => {
        event.stopPropagation();
        renaming.start();
      }}
    >
      {shown}
    </Tag>
  );
}

/** The pencil beside a name: shown while its container is hovered or holds the focus, and always to the keyboard. */
export function RenameButton({ renaming, label = 'Rename', className }: { renaming: Renaming; label?: string; className?: string }) {
  if (renaming.editing) return null;
  return (
    <IconButton
      icon={<Pencil />}
      size="xs"
      aria-label={label}
      title={label}
      className={cx('rename-button nodrag', className)}
      onClick={(event) => {
        event.stopPropagation();
        renaming.start();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
