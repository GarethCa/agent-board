import { createContext, useContext } from 'react';

/**
 * Opens a local web address from an agent's output in a web tab of the session window its terminal is in (BI2).
 * Undefined outside a window that has tabs, where such an address is left as text.
 */
export const WebLinkContext = createContext<((url: string) => void) | undefined>(undefined);

export const useWebLinkOpener = () => useContext(WebLinkContext);
