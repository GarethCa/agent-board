import type { Finder } from './dom-find';

/** Finds in a web tab's page (or an HTML document's), which the main process searches and highlights. */
export function pageFinder(tabId: string): Finder {
  return {
    search: (text, step) => (text === '' ? window.agentBoard.webTabs.stopFind(tabId).then(() => ({ active: 0, total: 0 })) : window.agentBoard.webTabs.find(tabId, text, step)),
    takeKeyboard: () => void window.agentBoard.webTabs.focusWindow(tabId).catch(() => {}),
    focus: () => void window.agentBoard.webTabs.focus(tabId).catch(() => {}),
    clear: () => void window.agentBoard.webTabs.stopFind(tabId).catch(() => {}),
  };
}
