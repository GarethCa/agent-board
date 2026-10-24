import { useEffect, useState } from 'react';
import { ARRANGE_SPACINGS, DEFAULT_ARRANGE_SPACING, type ArrangeSpacing } from '@agent-board/daemon/protocol';
import { SPACING_LABELS } from '../board/ZoneNode';
import { Fieldset, Hint, Segmented } from '../ui';

/**
 * Settings › Board › Arrange spacing: how far apart a new zone's Tidy and its orchestrators' arrange put things. Each
 * zone keeps its own, picked from its tab's ▾; this is only what a new zone starts with. The daemon keeps it.
 */
export function ArrangeSpacingSetting({ onError }: { onError: (action: string) => (error: unknown) => void }) {
  const [spacing, setSpacing] = useState<ArrangeSpacing>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => setSpacing(settings.arrangeSpacing), onError('read the arrange spacing'));
    return window.agentBoard.flowEdges.onSettingsChanged((event) => setSpacing(event.settings.arrangeSpacing));
  }, [onError]);

  const change = (arrangeSpacing: ArrangeSpacing) =>
    window.agentBoard.flowEdges.setSettings({ arrangeSpacing }).then((settings) => setSpacing(settings.arrangeSpacing), onError('change the arrange spacing'));

  return (
    <Fieldset legend="Arrange spacing">
      <Segmented
        aria-label="Arrange spacing"
        options={ARRANGE_SPACINGS.map((id) => ({ id, label: SPACING_LABELS[id] }))}
        value={spacing ?? DEFAULT_ARRANGE_SPACING}
        onChange={change}
      />
      <Hint>How far apart Tidy and an agent&apos;s arrange put tiles and lanes in a new zone. Each zone keeps its own: pick it from the ▾ beside its tab&apos;s Tidy, which tidies it at once.</Hint>
    </Fieldset>
  );
}
