import { CalmTileGallery } from './board/CalmTileGallery';
import { CharacterGallery } from './board/CharacterGallery';
import { PortholeTileGallery } from './board/PortholeTileGallery';
import { ShelfTileGallery } from './board/ShelfTileGallery';
import { QueueGallery } from './board/items/QueueGallery';
import { PrefabBoardGallery } from './crews/PrefabBoardGallery';
import { CrewGallery, PrefabGallery, TicketGallery } from './crews/PrefabGallery';
import { StatusMarkGallery } from './board/StatusMarkGallery';
import { CrowdedOrchestratorGallery, TileGallery } from './board/TileGallery';
import { StepsGallery } from './board/items/StepsGallery';
import { TicketBoardGallery, TicketOpenGallery, TicketOpenReadGallery, TicketPopupRowGallery, TicketTileGallery, TicketWatchGallery } from './board/TicketTileGallery';
import { QuickAskDialogGallery, QuickAskGallery } from './board/QuickAskGallery';
import { useSimplified } from './design';
import { ComponentGallery, ReadoutGallery } from './ui/ComponentGallery';

/**
 * The dev gallery at `#gallery`: every primitive in every state, every tile state, every character pose, under the
 * Simplified design every status mark and an agent's calm tile in each status, every look of a steps card,
 * a queue's looks, the quick ask on a tile, a crew prefab's flow editor, the crew library and a crew's prompt box, and last
 * (so it moves nothing above) a crowded orchestrator's tile and the component gallery's readouts. A queue handed on has its own page.
 */
export function Gallery() {
  const simplified = useSimplified();
  return (
    <div className="gallery">
      <ComponentGallery />
      <TileGallery />
      <CharacterGallery captain={simplified} />
      {simplified && <StatusMarkGallery />}
      {simplified && <CalmTileGallery />}
      <StepsGallery />
      <QueueGallery />
      <QuickAskGallery />
      <PrefabGallery />
      <CrewGallery />
      {/* Last, in the order they were added: each sits below every shot with an older baseline, and the foot below keeps
          the page's end out of reach, so adding one moves none of them. */}
      <CrowdedOrchestratorGallery />
      <ReadoutGallery />
      <QuickAskDialogGallery />
      <TicketTileGallery />
      <TicketWatchGallery />
      <TicketOpenGallery />
      <TicketGallery />
      <TicketBoardGallery />
      <TicketOpenReadGallery />
      <PortholeTileGallery />
      <ShelfTileGallery />
      <PrefabBoardGallery />
      <TicketPopupRowGallery />
      <GalleryFoot />
    </div>
  );
}

/**
 * A screen's height of empty page below the last gallery. A shot scrolls its section to the middle of the window unless
 * the page's end stops it; with the end a screen away, no section reaches it, so a taller page moves no shot.
 */
function GalleryFoot() {
  return <div className="gallery-foot" aria-hidden="true" />;
}
