import { useEffect, useState } from 'react';
import { Hint, Switch } from '../ui';

type OnError = (action: string) => (error: unknown) => void;

/**
 * Whether a document or plan an agent asks to show on the board is put there as a card beside its tile. Off by default:
 * a document is listed with its agent (its window's Made, its ticket, ⌘K), and a plan waits in Needs you.
 */
export function DocTilesSetting({ onError }: { onError: OnError }) {
  const [on, setOn] = useState<boolean>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => setOn(settings.placeDocTiles), onError('read the doc cards setting'));
    return window.agentBoard.flowEdges.onSettingsChanged((event) => setOn(event.settings.placeDocTiles));
  }, [onError]);

  return (
    <>
      <Switch
        label="Put docs agents show on the board"
        checked={on ?? false}
        disabled={on === undefined}
        data-testid="place-doc-tiles"
        onChange={(event) =>
          void window.agentBoard.flowEdges.setSettings({ placeDocTiles: event.target.checked }).then((settings) => setOn(settings.placeDocTiles), onError('change the doc cards setting'))
        }
      />
      <Hint>
        Off, a document an agent shows opens in its window and is listed under Made there, on its ticket and in ⌘K, and a plan waits in Needs you. On, one an
        agent asks to put on the board gets a card beside its tile too.
      </Hint>
    </>
  );
}
