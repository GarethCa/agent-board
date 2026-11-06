import { CalmTileGallery } from './board/CalmTileGallery';
import { CharacterGallery } from './board/CharacterGallery';
import { MemoryGallery } from './board/items/MemoryGallery';
import { QueueGallery } from './board/items/QueueGallery';
import { CrewGallery, PrefabGallery } from './crews/PrefabGallery';
import { StatusMarkGallery } from './board/StatusMarkGallery';
import { CrowdedOrchestratorGallery, TileGallery } from './board/TileGallery';
import { StepsGallery } from './board/items/StepsGallery';
import { QuickAskGallery } from './board/QuickAskGallery';
import { useSimplified } from './design';
import { ComponentGallery } from './ui/ComponentGallery';

/**
 * The dev gallery at `#gallery`: every primitive in every state, every tile state, every character pose, under the
 * Simplified design every status mark and an agent's calm tile in each status, every look of a steps card, a memory's
 * looks and a queue's, the quick ask on a tile, a crew prefab's flow editor, the crew library and a crew's prompt box, and last
 * (so it moves nothing above) a crowded orchestrator's tile. A queue handed on has its own page.
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
      <MemoryGallery />
      <QueueGallery />
      <QuickAskGallery />
      <PrefabGallery />
      <CrewGallery />
      {/* Last: it sits below every shot that has a baseline, so none of them moves. */}
      <CrowdedOrchestratorGallery />
    </div>
  );
}
