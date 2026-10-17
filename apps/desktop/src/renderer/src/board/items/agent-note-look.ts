// How agent notes look: a document card in the app's UI type (the default) or a cut of the agent's
// terminal. A view setting, kept in the daemon's view state; every agent note switches as it changes.
import { createContext } from 'react';

export type AgentNoteLook = 'document' | 'terminal';

/** The setting as saved (view state, read back untyped): document cards unless terminal cards were saved. */
export function agentNoteLookFrom(saved: unknown): AgentNoteLook {
  return saved === 'terminal' ? 'terminal' : 'document';
}

export const AgentNoteLookContext = createContext<AgentNoteLook>('document');
