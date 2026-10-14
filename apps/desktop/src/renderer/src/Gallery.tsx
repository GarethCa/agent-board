import { CharacterGallery } from './board/CharacterGallery';
import { TileGallery } from './board/TileGallery';
import { ComponentGallery } from './ui/ComponentGallery';

/** The dev gallery at `#gallery`: every primitive in every state, every tile state and every character pose. */
export function Gallery() {
  return (
    <div className="gallery">
      <ComponentGallery />
      <TileGallery />
      <CharacterGallery />
    </div>
  );
}
