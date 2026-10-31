import { CalmTileGallery } from './board/CalmTileGallery';
import { CharacterGallery } from './board/CharacterGallery';
import { StatusMarkGallery } from './board/StatusMarkGallery';
import { TileGallery } from './board/TileGallery';
import { useSimplified } from './design';
import { ComponentGallery } from './ui/ComponentGallery';

/** The dev gallery at `#gallery`: every primitive in every state, every tile state and every character pose, and
 * under the Simplified design every status mark and an agent's calm tile in each status. */
export function Gallery() {
  const simplified = useSimplified();
  return (
    <div className="gallery">
      <ComponentGallery />
      <TileGallery />
      <CharacterGallery captain={simplified} />
      {simplified && <StatusMarkGallery />}
      {simplified && <CalmTileGallery />}
    </div>
  );
}
