import { DOCK_LABELS, DOCK_MODES } from '../../../shared/dock';
import { useDock } from '../dock';
import { Fieldset, Hint, Segmented } from '../ui';

const DOCK_OPTIONS = DOCK_MODES.map((id) => ({ id, label: DOCK_LABELS[id] }));

/**
 * Settings › Board › Opening tiles › Dock: what the dock along the board's bottom edge holds. Every window follows a pick at once.
 * Whatever the dock leaves out is still found in ⌘K's Windows group and the Window menu.
 */
export function DockSetting({ onError }: { onError: (action: string) => (error: unknown) => void }) {
  const dock = useDock();
  return (
    <Fieldset legend="Dock">
      <Segmented
        aria-label="Dock"
        options={DOCK_OPTIONS}
        value={dock}
        onChange={(mode) => void window.agentBoard.dock.set(mode).catch(onError('change the dock'))}
      />
      <Hint>All keeps every minimised or popped-out window in the dock; Pinned only, just the ones you pin. Windows the dock leaves out are under Windows in ⌘K and in Window › Minimised.</Hint>
    </Fieldset>
  );
}
