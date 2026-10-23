import { createContext, useContext } from 'react';

/**
 * Opens an address from an agent's output in a web tab of the session window its terminal is in. Undefined outside a
 * window that has tabs, where a local address is left as text and an https one opens in the OS browser.
 */
export const WebLinkContext = createContext<((url: string) => void) | undefined>(undefined);

export const useWebLinkOpener = () => useContext(WebLinkContext);
