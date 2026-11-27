import { createContext } from 'react';
import { NO_LOOKUP, type TodoLookup } from './todo-view';

/** What a to-do list reads of the board: the agents that wrote its lines, as they are now. */
export const TodoLookupContext = createContext<TodoLookup>(NO_LOOKUP);
