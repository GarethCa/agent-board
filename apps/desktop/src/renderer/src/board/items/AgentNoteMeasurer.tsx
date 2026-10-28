// Each agent note's height for its text, measured out of sight, whether the board draws the note or not: it draws only
// what is on screen, and an arrange sizes a lane to its note's text as soon as that text changes, wherever it is.
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { Node } from '@xyflow/react';
import { MAX_AGENT_NOTE_HEIGHT } from '@agent-board/daemon/protocol';
import { forgetNoteFits, noteFitContext, noteFitKnown, reportNoteFits, useMeasuresChanged, type NoteFit } from '../measured-boxes';
import { tileNodeId } from '../tiles';
import { agentNoteData } from './agent-note';
import type { AgentNoteLook } from './agent-note-look';
import { AgentNoteBody, AgentNoteFace } from './AgentNoteNode';
import { isItemNode, type ItemNodeType } from './items';

/** How tall a note is laid out to be measured: tall enough for its tab, footer and some text, whatever it holds. */
const LAID_OUT_HEIGHT = MAX_AGENT_NOTE_HEIGHT;

const isAgentNote = (node: Node): node is ItemNodeType => isItemNode(node) && node.data.item.kind === 'agent-note';

const noLink = () => {};

/**
 * The heights the notes laid out in `roots`, each `height` tall, need for their text, shorter or taller (at most
 * `MAX_AGENT_NOTE_HEIGHT`), or 0 for one that can't be measured: each text laid out at its own height. No least: what
 * holds a note sets that. Read all at once, then all again, so the page is laid out twice, however many notes.
 */
function noteHeightsForText(roots: readonly (Element | null)[], height: number): number[] {
  const bodies = roots.map((root) => root?.querySelector<HTMLElement>('.agent-note-body') ?? null);
  const drawn = bodies.map((body) => (body === null || body.clientHeight === 0 ? undefined : body.offsetHeight));
  for (const body of bodies) if (body !== null) body.style.flex = '0 0 auto';
  const own = bodies.map((body) => body?.offsetHeight ?? 0);
  for (const body of bodies) if (body !== null) body.style.flex = '';
  return drawn.map((at, index) => (at === undefined ? 0 : Math.min(MAX_AGENT_NOTE_HEIGHT, Math.ceil(height + own[index]! - at))));
}

/**
 * Lays out, out of sight, each agent note among `nodes` whose height for its text isn't known as it is now (drawn as
 * `look` says, at its width), and says what it measured. Once a font has loaded, it measures them all again.
 */
export const AgentNoteMeasurer = memo(function AgentNoteMeasurer({ nodes, look }: { nodes: readonly Node[]; look: AgentNoteLook }) {
  useMeasuresChanged();
  const box = useRef<HTMLDivElement>(null);
  const ids = new Set(nodes.map((node) => node.id));
  // Not while it is being resized: it is measured at the width it is let go at, the one that is saved.
  const pending = nodes.filter(isAgentNote).flatMap((node) => {
    if (node.resizing === true) return [];
    const { item } = node.data;
    const fit = { width: node.width ?? item.width, text: agentNoteData(item.data).text, context: noteFitContext(look, item.data) };
    return noteFitKnown(node.id, fit) ? [] : [{ id: node.id, item, ...fit }];
  });

  useLayoutEffect(() => {
    if (pending.length === 0) return;
    const roots = pending.map(({ id }) => box.current?.querySelector(`[data-measure="${CSS.escape(id)}"]`) ?? null);
    const heights = noteHeightsForText(roots, LAID_OUT_HEIGHT);
    const fits = new Map<string, NoteFit>();
    pending.forEach(({ id, width, text, context }, index) => {
      if (heights[index]! > 0) fits.set(id, { width, height: heights[index]!, text, context });
    });
    reportNoteFits(fits);
  });

  useEffect(() => {
    document.fonts.addEventListener('loadingdone', forgetNoteFits);
    return () => document.fonts.removeEventListener('loadingdone', forgetNoteFits);
  }, []);

  if (pending.length === 0) return null;
  return (
    <div ref={box} className="agent-note-measurer" aria-hidden inert>
      {pending.map(({ id, item, width, text }) => {
        const { agent } = agentNoteData(item.data);
        return (
          <div key={id} data-measure={id} style={{ width, height: LAID_OUT_HEIGHT }}>
            <AgentNoteFace
              item={item}
              look={look}
              tileShown={agent.sessionId !== '' && ids.has(tileNodeId('agent', agent.sessionId))}
              body={<AgentNoteBody text={text} look={look} openLink={noLink} />}
              measuring
            />
          </div>
        );
      })}
    </div>
  );
});
