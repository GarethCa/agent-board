import { setTileDesign, TILE_DESIGN_CHOICES, useTileDesign, type TileDesign } from '../board/tile-design';
import { Fieldset, Hint, Segmented } from '../ui';

const LABELS: Record<TileDesign, string> = { current: 'Today’s', porthole: 'Porthole', shelf: 'Shelf' };

/** Settings › General › Design › Tile design: how every agent's tile on the board is drawn. */
export function TileDesignSetting() {
  return (
    <Fieldset legend="Tile design">
      <Segmented aria-label="Tile design" options={TILE_DESIGN_CHOICES.map((id) => ({ id, label: LABELS[id] }))} value={useTileDesign()} onChange={setTileDesign} />
      <Hint>How an agent’s tile looks on the board. Porthole shows its robot in a round window whose ring carries its state; Shelf has its robot peek over the top, and a band along the bottom carries its state.</Hint>
    </Fieldset>
  );
}
