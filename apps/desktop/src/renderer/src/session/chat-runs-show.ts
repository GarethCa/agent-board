// When the chat's Expand all / Collapse all show: always, by default, or only while the pointer is over
// the header or tab row that holds them (Settings › Board › Agent tiles).

export type ChatRunsShow = 'always' | 'hover';

/** The saved setting: always, unless it was set to show on hover. */
export function chatRunsShowFrom(saved: unknown): ChatRunsShow {
  return saved === 'hover' ? 'hover' : 'always';
}

/**
 * Which of a session window's slots holds the chat's controls: the tab row where it has one; else the header, which
 * under Simplified is its in-line slot by the name when they always show, or its view slot, beside Chat | Timeline |
 * Terminal, when they show on hover, as the rest of that header does.
 */
export type ChatControlsPlace = 'tab-row' | 'header' | 'simplified-header' | 'view-slot';

export function chatControlsPlace({ tabRow, simplified, show }: { tabRow: boolean; simplified: boolean; show: ChatRunsShow }): ChatControlsPlace {
  if (tabRow) return 'tab-row';
  if (!simplified) return 'header';
  return show === 'hover' ? 'view-slot' : 'simplified-header';
}
