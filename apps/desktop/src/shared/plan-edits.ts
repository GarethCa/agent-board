/** How a plan with an unsaved edit is named between windows: its agent's session and its version's id. */
export const planEditKey = (sessionId: string, planId: string): string => `${sessionId}:${planId}`;
