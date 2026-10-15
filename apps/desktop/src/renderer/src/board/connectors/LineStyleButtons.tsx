import { CONNECTOR_STYLES, type ConnectorStyle } from '@agent-board/daemon/protocol';
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
