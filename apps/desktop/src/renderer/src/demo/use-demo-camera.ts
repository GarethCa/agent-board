import { useEffect } from 'react';
import { useReactFlow, useStoreApi, type Rect } from '@xyflow/react';
import { cameraViewport, DEMO, demoEasing, type DemoEasing } from './demo-mode';

/** How long past its duration a move counts as over, if React Flow hasn't said so: a frame or so. */
const SETTLE_SLACK_MS = 20;

/**
 * In demo mode, gives a recording spec the board's camera as `window.__demo.camera` and `.fit`: slower, eased moves
 * than the board's own, which may zoom in. Each takes the duration it is given, even with reduced motion, and
 * resolves once it is over: when it finishes, or after its duration if another move cut it short. `zoneLayout`
 * finds a zone's place on the board, if there is such a zone.
 */
export function useDemoCamera(zoneLayout: (zoneId: string) => Rect | undefined): void {
  const { setViewport } = useReactFlow();
  const flowStore = useStoreApi();
  useEffect(() => {
    if (!DEMO) return;
    const camera = async (rect: Rect, ms: number, easing?: DemoEasing) => {
      const ease = demoEasing(easing);
      const { width, height, minZoom, maxZoom } = flowStore.getState();
      const moved = setViewport(cameraViewport(rect, { width, height, minZoom, maxZoom }), { duration: ms, ease });
      // React Flow settles a move only when it finishes: one cut short (by another move, or a click or wheel on the
      // board) never would, so the move's time is up after its duration either way.
      await Promise.race([moved, new Promise((done) => setTimeout(done, ms + SETTLE_SLACK_MS))]);
    };
    const fit = (zoneId: string, ms: number, easing?: DemoEasing) => {
      const rect = zoneLayout(zoneId);
      if (rect === undefined) return Promise.reject(new Error(`no zone ${zoneId} on the board`));
      return camera(rect, ms, easing);
    };
    const demo = (window.__demo ??= {});
    Object.assign(demo, { camera, fit });
    return () => {
      delete demo.camera;
      delete demo.fit;
    };
  }, [setViewport, flowStore, zoneLayout]);
}
