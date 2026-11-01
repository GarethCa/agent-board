import type { AgentNotification } from './alerts';

/** What a notification says: about an agent, or about the app itself (no `sessionId`, kind or name). */
export type AppNotification = Omit<AgentNotification, 'sessionId' | 'kind' | 'name'> & Partial<Pick<AgentNotification, 'sessionId' | 'kind' | 'name'>>;
