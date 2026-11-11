import { useContext, useState, type CSSProperties, type MouseEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Ellipsis, FoldVertical, UnfoldVertical } from 'lucide-react';
import { useSimplified } from '../design';
import { Chip, ContextMenu, EditableName, Menu, useRenaming } from '../ui';
import { chipLine } from './fold-zone';
import { chipMenu } from './menu-model';
import { ProjectSummaryContext } from './project-summary';
import { StatusGlyph } from './StatusMark';
import { ZoneBindingContext, type ZoneNodeType } from './ZoneNode';

/** A zone header's Fold button, the same in both designs but for what each calls a zone. */
export function FoldButton({ className, noun, onFold }: { className: string; noun: 'zone' | 'project'; onFold: () => void }) {
  return (
    <Chip
      className={`${className} nodrag`}
      icon={<FoldVertical />}
      aria-label={`Fold ${noun}`}
      title="Fold to a chip: pauses its agents that can pause and lets their terminals go"
      onClick={onFold}
    />
  );
}

/**
 * A zone folded away while it isn't needed, drawn as a chip in both designs: its colour's dot, its name, how many of its
 * agents and external sessions need the user (so nothing urgent hides), a count of the rest, and Unfold. Its tiles are
 * not drawn and its agents are paused, so it costs the board no memory. Dragging the chip moves the zone; ⋯ and
 * right-click unfold it, or unfold and wake its agents, rename it or delete it.
 */
export function FoldedZone({ data: { zone }, positionAbsoluteX, positionAbsoluteY, width, height }: NodeProps<ZoneNodeType>) {
  const binding = useContext(ZoneBindingContext);
  const simplified = useSimplified();
  // The Simplified design calls a zone a project.
  const noun = simplified ? 'project' : 'zone';
  const summary = useContext(ProjectSummaryContext).get(zone.id);
  const renaming = useRenaming(zone.name, (name) => binding.rename(zone, name));
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const entries = () => chipMenu({ zone, rename: renaming.startSoon, actions: binding, simplified });
  const needsYou = summary?.needsYou ?? 0;
  const onContextMenu = (event: MouseEvent) => {
    // A right-click in its own menu reaches here through the portal: it is the menu's, not a new one.
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    setMenuAt({ x: event.clientX, y: event.clientY });
  };
  return (
    <div
      className="zone folded-zone"
      data-testid="zone"
      data-kind={zone.kind}
      data-folded
      data-x={positionAbsoluteX}
      data-y={positionAbsoluteY}
      data-width={width}
      data-height={height}
      style={{ '--zone-color': zone.color } as CSSProperties}
      onContextMenu={onContextMenu}
    >
      <div className="folded-zone-row" data-testid="zone-tab" title={`${zone.name} is folded`}>
        <span className="project-dot" aria-hidden="true" />
        <EditableName className="project-name" value={zone.name} renaming={renaming} label={simplified ? 'Project name' : 'Zone name'} />
        {needsYou > 0 && (
          <span className="project-needs-you" data-testid="folded-needs-you" aria-label={`${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`}>
            <StatusGlyph status="needs-you" />
            {needsYou}
          </span>
        )}
        <span className="project-summary folded-zone-summary" data-testid="folded-summary">
          {chipLine(summary)}
        </span>
        <Chip className="project-options folded-zone-unfold nodrag" icon={<UnfoldVertical />} aria-label={`Unfold ${noun}`} title="Unfold: its agents stay paused until you wake them" onClick={() => binding.unfold(zone, false)} />
        <Menu entries={entries()}>
          <Chip className="project-options nodrag" icon={<Ellipsis />} aria-label={`${simplified ? 'Project' : 'Zone'} options`} title="Unfold, unfold and wake its agents, rename, delete" />
        </Menu>
      </div>
      {menuAt !== undefined && <ContextMenu at={menuAt} label={`${zone.name} ${noun}`} entries={entries()} onClose={() => setMenuAt(undefined)} />}
    </div>
  );
}
