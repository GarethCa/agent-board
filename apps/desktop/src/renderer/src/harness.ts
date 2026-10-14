import type { Harness } from '@agent-board/daemon/protocol';

/** How the app shows each harness: its name, and the colour of its mark. */
export const HARNESSES: Record<Harness, { label: string; color: string }> = {
  claude: { label: 'Claude', color: 'var(--harness-claude)' },
  codex: { label: 'Codex', color: 'var(--harness-codex)' },
};
