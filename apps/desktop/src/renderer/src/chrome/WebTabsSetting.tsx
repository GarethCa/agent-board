import { useEffect, useState } from 'react';
import { Button, Dialog, ErrorText, Hint, Switch } from '../ui';
import { ipcErrorMessage } from '../../../shared/errors';

type OnError = (action: string) => (error: unknown) => void;

/** What asking first is for: turning the switch off, or Clear browsing data, both of which empty the shared session. */
type Asking = 'off' | 'clear';

/**
 * Whether web tabs keep logins between sessions: one session they share, kept on disk, as a browser's. On by default.
 * Off, every web tab is private, those open now reloaded so, signed out, and what was kept is cleared. Clear browsing data empties the shared
 * session (its cookies, storage and cache) and leaves the switch as it is. Both ask first.
 */
export function WebTabsSetting({ onError }: { onError: OnError }) {
  const [on, setOn] = useState<boolean>();
  const [asking, setAsking] = useState<Asking>();
  const [busy, setBusy] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => setOn(settings.keepWebLogins), onError('read the web tabs setting'));
    return window.agentBoard.flowEdges.onSettingsChanged((event) => setOn(event.settings.keepWebLogins));
  }, [onError]);

  const save = (keepWebLogins: boolean) =>
    window.agentBoard.flowEdges.setSettings({ keepWebLogins }).then((settings) => setOn(settings.keepWebLogins), onError('change the web tabs setting'));

  const answer = async (confirmed: boolean) => {
    const was = asking;
    setAsking(undefined);
    if (!confirmed || was === undefined) return;
    setBusy(true);
    setProblem(undefined);
    setCleared(false);
    try {
      // Turning it off clears in the main process too, as it hears the change: clearing first leaves nothing behind
      // should that change not go through.
      await window.agentBoard.webTabs.clearData();
      setCleared(true);
      if (was === 'off') await save(false);
    } catch (error) {
      setProblem(`Could not clear browsing data: ${ipcErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Switch
        label="Keep logins between sessions"
        checked={on ?? true}
        disabled={on === undefined || busy}
        onChange={(event) => {
          setCleared(false);
          if (event.target.checked) void save(true);
          else setAsking('off');
        }}
      />
      <Hint>
        Web tabs share one session kept on disk, as a browser does, so a login lasts past closing the tab and restarting the app. Agents can&apos;t read, drive
        or screenshot a web tab, but a link they give you opens signed in, and they can see the address a tab ends up at. Off, every web tab is private and
        forgets everything as it closes. macOS may ask to let agent-board use its keychain, where the kept cookies&apos; key is: choose Always Allow, or logins
        won&apos;t be kept.
      </Hint>
      <div>
        <Button size="sm" disabled={busy} onClick={() => setAsking('clear')}>
          Clear browsing data…
        </Button>
      </div>
      {cleared && <Hint data-testid="web-data-cleared">Browsing data cleared.</Hint>}
      {problem !== undefined && <ErrorText>{problem}</ErrorText>}
      {asking !== undefined && (
        <Dialog
          role="alertdialog"
          title={asking === 'off' ? 'Stop keeping logins?' : 'Clear browsing data?'}
          onClose={() => void answer(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => void answer(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void answer(true)} data-testid="web-data-confirm">
                {asking === 'off' ? 'Turn off and clear' : 'Clear'}
              </Button>
            </>
          }
        >
          {asking === 'off'
            ? 'Signs every web tab out of every site and deletes their cookies, site storage and cache. Web tabs open now reload, privately: from now on each keeps nothing past itself.'
            : 'Signs every web tab out of every site, and deletes their cookies, site storage and cache. Pages open now keep what they show until they reload.'}
        </Dialog>
      )}
    </>
  );
}
