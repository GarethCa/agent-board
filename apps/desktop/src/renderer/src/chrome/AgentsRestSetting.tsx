import { useEffect, useState } from 'react';
import { Hint, Switch } from '../ui';

type OnError = (action: string) => (error: unknown) => void;

/** Whether an agent that says it is resting is paused as its turn ends. On by default; off, resting only sets its tile line. */
export function AgentsRestSetting({ onError }: { onError: OnError }) {
  const [on, setOn] = useState<boolean>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => setOn(settings.agentsRest), onError('read the resting setting'));
    return window.agentBoard.flowEdges.onSettingsChanged((event) => setOn(event.settings.agentsRest));
  }, [onError]);

  const save = (agentsRest: boolean) =>
    window.agentBoard.flowEdges.setSettings({ agentsRest }).then((settings) => setOn(settings.agentsRest), onError('change the resting setting'));

  return (
    <>
      <Switch label="Pause agents that rest" checked={on ?? true} disabled={on === undefined} onChange={(event) => void save(event.target.checked)} />
      <Hint>
        An agent waiting on someone else can say it is resting. It is paused as its turn ends, freeing the memory it holds, and a message or Wake starts it
        again with its conversation. Off, resting only sets its tile line.
      </Hint>
    </>
  );
}
