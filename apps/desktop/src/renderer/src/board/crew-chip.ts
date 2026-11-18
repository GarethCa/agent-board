// Which crew tiles carry a "↳ from <orchestrator>" chip: an agent an orchestrator started that sits outside its crew
// frame. An orchestrator's crew is otherwise shown by the crew count on its tile; focusing it changes no other tile.
import { createContext } from 'react';

export interface CrewView {
  /** The agents (by session id) in a crew frame: a crew tile that isn't carries a "from" chip. */
  framed: ReadonlySet<string>;
}

export const CrewViewContext = createContext<CrewView>({ framed: new Set() });
