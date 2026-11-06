import { setViewSetting, useViewSettings } from '../board/view-settings';
import { Hint, Switch } from '../ui';

/**
 * Settings › Advanced › Terminals: whether terminals draw with the GPU (xterm's WebGL renderer, session/terminal-gpu.ts).
 * On by default. Every window follows a change at once, its terminals kept as they are.
 */
export function GpuTerminalsSetting() {
  const { gpuTerminals } = useViewSettings();
  return (
    <>
      <Switch label="GPU-accelerated terminals" checked={gpuTerminals} onChange={(event) => setViewSetting('gpuTerminals', event.target.checked)} />
      <Hint>
        Terminals draw with the graphics card: less work as a terminal fills in, and blocks of colour stay even when the board is zoomed out. Zoomed in past 100%,
        their text is a little softer. Off, or where the graphics card can&apos;t be used, they draw as web page text.
      </Hint>
    </>
  );
}
