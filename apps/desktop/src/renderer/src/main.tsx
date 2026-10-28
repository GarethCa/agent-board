import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describeBuild } from '@agent-board/daemon/protocol';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/jetbrains-mono/index.css';
// Every subset (Latin Extended, Cyrillic): each loads only when a note uses its letters.
import '@fontsource/caveat/600.css';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './theme-packs.css';
import './ui/ui.css';
import './app.css';
import './chrome/chrome.css';
import './onboarding/onboarding.css';
import './demo/demo.css';
import { App } from './App';
import { Gallery } from './Gallery';
import { WINDOW_QUERY, windowTargetFrom } from '../../preload/api';
import { PopOutWindow } from './windows/PopOutWindow';
import { CAPTURE_FRAME } from './board/capture-mode';
import { DEMO } from './demo/demo-mode';
import { ReviewsProvider } from './review/ReviewsProvider';
import { GatesProvider } from './gate/GatesProvider';
import { followTheme } from './themes';
import { followExtendedShortcuts } from './keys/extended-shortcuts';
import { ToastProvider, TooltipProvider } from './ui';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

// Set by the main process for a popped-out session window (main/windows.ts).
const popOut = windowTargetFrom(new URLSearchParams(location.search), WINDOW_QUERY.popOut);

// The build is in the board's title so screenshots and bug reports name the commit. A popped-out window is titled by
// its session (PopOutWindow), which this would otherwise overwrite whenever it resolved later.
if (popOut === undefined) void window.agentBoard.build().then((build) => (document.title = `agent-board · ${describeBuild(build)}`));

// The theme for the window's light or dark mode, which the Appearance setting drives (themes.ts): set before the first
// paint, and again whenever macOS or the setting changes it.
followTheme();

// A capture window shows the board's canvas alone (board/capture-mode.ts, app.css).
if (CAPTURE_FRAME !== undefined) document.documentElement.dataset.capture = '';

// Demo mode hides the chrome that only matters while developing (demo/demo-mode.ts, demo/demo.css).
if (DEMO) document.documentElement.dataset.demo = '';

// Whether the keys added since the key registry work: read as the window opens, and again as it comes to the front.
followExtendedShortcuts();

// How the window is framed, for the styles that leave room for macOS's traffic lights and draw the drag regions round
// them. In full screen the lights hide, and what sat beside them moves into the corner.
const { windows } = window.agentBoard;
document.documentElement.dataset.chrome = windows.chrome;
const setFullScreen = (fullScreen: boolean) => (document.documentElement.dataset.fullScreen = String(fullScreen));
// Asked once, unless a change arrives first: the answer would be older than the change.
let changed = false;
windows.onFullScreenChanged((fullScreen) => {
  changed = true;
  setFullScreen(fullScreen);
});
void windows.isFullScreen().then((fullScreen) => changed || setFullScreen(fullScreen), () => {});

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <ToastProvider>
        {popOut !== undefined ? (
          <ReviewsProvider>
            <GatesProvider>
              <PopOutWindow target={popOut} />
            </GatesProvider>
          </ReviewsProvider>
        ) : location.hash === '#gallery' ? (
          // A dev gallery of every primitive, tile state and character pose, for checking how they look.
          <Gallery />
        ) : (
          <ReviewsProvider>
            <GatesProvider>
              <App />
            </GatesProvider>
          </ReviewsProvider>
        )}
      </ToastProvider>
    </TooltipProvider>
  </StrictMode>,
);
