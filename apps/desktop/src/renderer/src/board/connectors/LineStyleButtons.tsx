import { CONNECTOR_STYLES, type ConnectorStyle } from '@agent-board/daemon/protocol';
import { Route } from 'lucide-react';
import { BarButton, BarSample } from '../items/ItemStyleBar';
import { upperFirst } from '../../upper-first';

/** How a bar button draws each style of line. */
const STYLE_SAMPLES: Record<ConnectorStyle, string> = {
  straight: 'M4 19 L20 5',
  elbow: 'M4 19 H12 V5 H20',
  curved: 'M4 19 C13 19 11 5 20 5',
};

/** A style bar's buttons for a line's style, a connector's or a hand-off's: straight, elbow or curved. */
export function LineStyleButtons({ current, onPick }: { current: ConnectorStyle; onPick(style: ConnectorStyle): void }) {
  return CONNECTOR_STYLES.map((style) => (
    <BarButton key={style} name={upperFirst(style)} pressed={current === style} onClick={() => onPick(style)}>
      <BarSample path={STYLE_SAMPLES[style]} />
    </BarButton>
  ));
}

/**
 * A style bar's button that takes out a line's bends, so it routes round the objects between its ends again: shown on
 * an elbow or curve the user bent, the only lines that don't route on their own.
 */
export function RouteButton({ style, bent, onRoute }: { style: ConnectorStyle; bent: boolean; onRoute(): void }) {
  if (style === 'straight' || !bent) return null;
  return (
    <BarButton name="Route automatically" onClick={onRoute}>
      <Route />
    </BarButton>
  );
}
