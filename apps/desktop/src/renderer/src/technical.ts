import { useSyncExternalStore } from 'react';
import type { Design } from '../../shared/design';
import { showsTechnicalDetails } from '../../shared/technical';
import { isSimplified, observeRoot, type DesignSource } from './design';

// Show technical details (docs/adr/0022-simplified-design.md): `data-technical` on the root while the switch is on under
// the Simplified design, and never under Classic, which always shows the technical layer and has no switch. The layer
// only adds: a technical bit tagged `data-technical-detail` (app.css) or rendered behind `useTechnicalDetails()` is
// left out while it is off, and nothing else moves.

/** What `followTechnical` needs of the switch: its value as the window opened, and its changes. */
export interface TechnicalSource {
  initial: boolean;
  onChanged(listener: (technical: boolean) => void): () => void;
}

/** Shows the switch on `root`, now and whenever it or the design changes in any window. Returns a stop function. */
export function followTechnical(
  root: { dataset: DOMStringMap } = document.documentElement,
  source: TechnicalSource = window.agentBoard.technical,
  design: DesignSource = window.agentBoard.design,
): () => void {
  let technical = source.initial;
  let shown: Design = design.initial;
  const show = () => {
    if (shown === 'simplified' && technical) root.dataset.technical = '';
    else delete root.dataset.technical;
  };
  show();
  const stopTechnical = source.onChanged((value) => {
    technical = value;
    show();
  });
  const stopDesign = design.onChanged((value) => {
    shown = value;
    show();
  });
  return () => {
    stopTechnical();
    stopDesign();
  };
}

/** Whether the root shows the technical layer: under Classic always, under the Simplified design while it is marked. */
export function technicalShown(root: { dataset: DOMStringMap } = document.documentElement): boolean {
  return showsTechnicalDetails(isSimplified(root) ? 'simplified' : 'classic', 'technical' in root.dataset);
}

const subscribe = observeRoot('data-design', 'data-technical');

/**
 * Whether this window shows the technical layer, for a component that leaves a technical bit out (or disables an item
 * that needs one) while it is off. Always true under Classic.
 */
export function useTechnicalDetails(): boolean {
  return useSyncExternalStore(subscribe, () => technicalShown());
}
