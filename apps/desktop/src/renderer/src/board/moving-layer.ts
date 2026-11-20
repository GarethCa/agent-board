// While the board's camera moves, its moving layer (`.react-flow__viewport`) gets its own compositor layer
// (`will-change: transform`): the GPU then stretches the picture it has, instead of drawing the board's tiles again at each
// new scale of a pinch. A promoted layer stays drawn at the scale it was promoted at, so a pinch in looks soft until the
// camera stops; a short while after it does, the promotion is dropped and the board is drawn sharp once, at its new scale.

/**
 * How long after the camera stops the layer stays promoted: a pan or pinch that goes on within it costs no new raster.
 * Short, as React Flow already waits 150 ms after the last wheel or pinch event before it says the camera stopped; this
 * is for a drag that pauses and goes on.
 */
export const MOVING_LAYER_HOLD_MS = 50;

export interface MovingLayer {
  /** The camera started moving. */
  started(): void;
  /** The camera came to rest. */
  ended(): void;
  dispose(): void;
}

/** Promotes the moving layer in `root()` while the camera moves, and for `hold` ms after. */
export function movingLayer(root: () => HTMLElement | null, hold = MOVING_LAYER_HOLD_MS): MovingLayer {
  let layer: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drop = () => {
    clearTimeout(timer);
    timer = undefined;
    layer?.style.removeProperty('will-change');
    layer = null;
  };
  return {
    started() {
      clearTimeout(timer);
      timer = undefined;
      const next = root()?.querySelector<HTMLElement>('.react-flow__viewport') ?? null;
      if (next !== layer) drop();
      layer = next;
      layer?.style.setProperty('will-change', 'transform');
    },
    ended() {
      clearTimeout(timer);
      timer = setTimeout(drop, hold);
    },
    dispose: drop,
  };
}
