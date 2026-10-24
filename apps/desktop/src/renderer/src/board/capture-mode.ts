// The board as a capture window draws it (shared/capture.ts). What it draws is decided here, and nowhere else: the
// canvas alone (Board leaves out every panel, dialog, chrome and session window), and on it the frame's zone, the
// tiles and items in it and the edges between them; nothing loose, and nothing of another zone. It is ready to be
// captured once it has loaded and stopped changing.
import { useEffect } from 'react';
import { useNodesInitialized, type Edge, type Node, type Viewport } from '@xyflow/react';
import { captureFrameFrom, type CaptureFrame } from '../../../shared/capture';
import { QUESTION_CARD_TYPE } from './question-cards';
import { tileNodeId } from './tiles';

/** This window's frame, if it is a capture window. Read once: a capture window draws one zone and closes. */
export const CAPTURE_FRAME: CaptureFrame | undefined = typeof location === 'undefined' ? undefined : captureFrameFrom(location.search);

/** The viewport that puts the frame's top-left at the window's, at its scale. */
export const captureViewport = (frame: CaptureFrame): Viewport => ({ x: -frame.x * frame.scale, y: -frame.y * frame.scale, zoom: frame.scale });

/**
 * Of `nodes`, the zone `zoneId`, what is in it and the question cards of its agents (loose on the board, beside their
 * tiles), none selected: what a picture of that zone shows.
 */
export function nodesInZone<N extends Node>(nodes: readonly N[], zoneId: string): N[] {
  const inZone = new Set(nodes.filter((node) => node.id === zoneId || node.parentId === zoneId).map((node) => node.id));
  const askedOf = (node: N) => node.type === QUESTION_CARD_TYPE && inZone.has(tileNodeId('agent', (node.data as { sessionId: string }).sessionId));
  return nodes.filter((node) => inZone.has(node.id) || askedOf(node)).map((node) => (node.selected === true ? { ...node, selected: false } : node));
}

/** Of `edges`, those both of whose ends are among `nodes`. */
export function edgesAmong<E extends Edge>(edges: readonly E[], nodes: readonly Node[]): E[] {
  const ids = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
}

/** How many frames in a row the board must go unchanged to count as settled. */
export const QUIET_FRAMES = 8;
/** The longest a capture waits for the board to settle; a board that never does (an animation) is taken then. */
const MAX_SETTLE_MS = 5_000;

/**
 * Counts frames since the board last changed: `changed` on a change, `frame` once a frame, which says whether
 * `quietFrames` frames have now passed with none.
 */
export function quietCounter(quietFrames = QUIET_FRAMES) {
  let quiet = 0;
  return {
    changed: () => void (quiet = 0),
    frame: () => ++quiet >= quietFrames,
  };
}

/**
 * Calls `done` once the canvas under `root` has gone `QUIET_FRAMES` frames with no node added, removed, moved or
 * resized, and no edge added, removed or rerouted (its path redrawn), or after `MAX_SETTLE_MS` at most. Returns the
 * cancel.
 */
function whenSettled(root: Element, done: () => void): () => void {
  const counter = quietCounter();
  const sizes = new ResizeObserver(counter.changed);
  // A node moves by its own style's transform: watched on the node alone, not what it holds, which may animate.
  const moves = new MutationObserver(counter.changed);
  const watchNodes = () =>
    root.querySelectorAll('.react-flow__node').forEach((node) => {
      sizes.observe(node);
      moves.observe(node, { attributes: true, attributeFilter: ['style'] });
    });
  const mutations = new MutationObserver((records) => {
    counter.changed();
    if (records.some((record) => record.type === 'childList')) watchNodes();
  });
  mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['d'] });
  watchNodes();
  let frame = 0;
  const finish = () => {
    stop();
    done();
  };
  const tick = () => (counter.frame() ? finish() : (frame = requestAnimationFrame(tick)));
  frame = requestAnimationFrame(tick);
  const cap = setTimeout(finish, MAX_SETTLE_MS);
  function stop() {
    cancelAnimationFrame(frame);
    clearTimeout(cap);
    sizes.disconnect();
    moves.disconnect();
    mutations.disconnect();
  }
  return stop;
}

/** In a capture window, tells main the board may be captured once it has loaded, its fonts are in and it has settled. */
export function useCaptureReady(loaded: boolean): void {
  const initialised = useNodesInitialized();
  useEffect(() => {
    if (CAPTURE_FRAME === undefined || !loaded || !initialised) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void document.fonts.ready.then(() => {
      const canvas = document.querySelector('.react-flow');
      if (cancelled || canvas === null) return;
      stop = whenSettled(canvas, () => window.agentBoard.capture.ready());
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [loaded, initialised]);
}
