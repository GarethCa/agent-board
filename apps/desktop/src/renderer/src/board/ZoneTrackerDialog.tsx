import { useEffect, useState, type FormEvent } from 'react';
import { TRACKER_PROVIDERS, type TrackerProvider, type TrackerScope, type Zone } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Dialog, ErrorText, Field, Input, Select } from '../ui';
import { trackerToSave } from './zone-tracker';
import { apiKeyHint, GhLoginHelp, LINEAR_KEY_PLACEHOLDER } from './tracker-help';

interface ZoneTrackerDialogProps {
  zone: Zone;
  onSaved(zone: Zone): void;
  onCancel(): void;
}

const PROVIDERS = Object.keys(TRACKER_PROVIDERS) as TrackerProvider[];

/**
 * Picks where the zone's issues come from: a Linear team or a GitHub repo. Linear without a stored API key asks for
 * one first; the daemon checks it with Linear and keeps it in the OS keychain. GitHub uses the gh CLI's own login,
 * so it never asks for a token: until gh is logged in, it says how.
 */
export function ZoneTrackerDialog({ zone, onSaved, onCancel }: ZoneTrackerDialogProps) {
  const [provider, setProvider] = useState<TrackerProvider>(zone.tracker?.provider ?? 'linear');
  /** The scopes the tracker can see; undefined until known, null when it needs a login first. */
  const [scopes, setScopes] = useState<TrackerScope[] | null>();
  const [scope, setScope] = useState(zone.tracker?.scope ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Bumped to ask the tracker for its scopes again, after logging gh in. */
  const [attempt, setAttempt] = useState(0);
  const { name, scopeName, auth } = TRACKER_PROVIDERS[provider];

  const fail = (failure: unknown) => {
    setError(errorMessage(failure));
    setBusy(false);
  };
  const showScopes = (found: TrackerScope[]) => {
    setScopes(found);
    // A GitHub repo may be typed, so keep what is there; a Linear team must be one of the list.
    setScope((current) =>
      auth === 'gh' || found.some((s) => s.key === current) ? current : (found[0]?.key ?? ''),
    );
    setBusy(false);
  };

  useEffect(() => {
    let cancelled = false;
    setScopes(undefined);
    setError(undefined);
    window.agentBoard.trackers.scopes(provider).then(
      (result) => {
        if (cancelled) return;
        if (result.status === 'ok') return showScopes(result.scopes);
        setScopes(null);
        if (result.refused !== undefined) setError(result.refused);
      },
      (failure: unknown) => {
        // The tracker, gh or the keychain can't be reached: say so, rather than asking again for a key that may be
        // fine.
        if (cancelled) return;
        setScopes([]);
        fail(failure);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [provider, attempt]);

  const pickProvider = (next: TrackerProvider) => {
    setProvider(next);
    setScope(next === zone.tracker?.provider ? zone.tracker.scope : '');
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    window.agentBoard.trackers.connect(provider, apiKey.trim()).then((found) => {
      setApiKey('');
      showScopes(found);
    }, fail);
  };

  const save = (tracker: Zone['tracker']) => {
    setBusy(true);
    setError(undefined);
    window.agentBoard.zones.setTracker(zone.id, tracker).then(onSaved, fail);
  };

  /** Forgets the stored key: the next look at the tracker asks for one again. */
  const disconnect = () => {
    setBusy(true);
    setError(undefined);
    window.agentBoard.trackers.disconnect(provider).then(() => {
      setScopes(null);
      setBusy(false);
    }, fail);
  };

  const providerPicker = (
    <Field label="Tracker">
      <Select value={provider} onChange={(event) => pickProvider(event.target.value as TrackerProvider)}>
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {TRACKER_PROVIDERS[p].name}
          </option>
        ))}
      </Select>
    </Field>
  );
  const errorLine = error && <ErrorText>{error}</ErrorText>;
  const cancel = (
    <Button variant="ghost" onClick={onCancel}>
      Cancel
    </Button>
  );

  if (scopes === null && auth === 'gh') {
    return (
      <Dialog
        aria-label="Zone tracker"
        title={`Connect ${name} for ${zone.name}`}
        onClose={onCancel}
        onSubmit={(event) => {
          event.preventDefault();
          setAttempt((n) => n + 1);
        }}
        footer={
          <>
            {cancel}
            <Button type="submit" variant="primary">
              Try again
            </Button>
          </>
        }
      >
        {providerPicker}
        <p>
          <GhLoginHelp />, then try again.
        </p>
        {errorLine}
      </Dialog>
    );
  }

  if (scopes === null) {
    return (
      <Dialog
        aria-label="Zone tracker"
        title={`Connect ${name} for ${zone.name}`}
        onClose={onCancel}
        onSubmit={connect}
        footer={
          <>
            {cancel}
            <Button type="submit" variant="primary" loading={busy} disabled={apiKey.trim() === ''}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </>
        }
      >
        {providerPicker}
        <Field label={`${name} API key`} hint={apiKeyHint(name)}>
          <Input type="password" autoFocus value={apiKey} placeholder={LINEAR_KEY_PLACEHOLDER} onChange={(event) => setApiKey(event.target.value)} />
        </Field>
        {errorLine}
      </Dialog>
    );
  }

  return (
    <Dialog
      aria-label="Zone tracker"
      title={`Issues for ${zone.name}`}
      onClose={onCancel}
      onSubmit={(event) => {
        event.preventDefault();
        // Saving the scope the zone already has keeps its project.
        save(trackerToSave(zone.tracker, provider, scope));
      }}
      footerStart={
        <>
          {zone.tracker !== null && (
            <Button variant="danger" disabled={busy} onClick={() => save(null)}>
              No tracker
            </Button>
          )}
          {auth !== 'gh' && (
            <Button variant="ghost" disabled={busy} title={`Remove the ${name} API key from your keychain`} onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </>
      }
      footer={
        <>
          {cancel}
          <Button type="submit" variant="primary" loading={busy} disabled={scope.trim() === ''}>
            Save
          </Button>
        </>
      }
    >
      {providerPicker}
      {auth === 'gh' ? (
        <Field label={`${name} ${scopeName}`}>
          <Input
            list="zone-tracker-repos"
            value={scope}
            placeholder="owner/repo"
            disabled={scopes === undefined}
            onChange={(event) => setScope(event.target.value)}
          />
          <datalist id="zone-tracker-repos">
            {scopes?.map((s) => <option key={s.key} value={s.key} />)}
          </datalist>
        </Field>
      ) : (
        <Field label={`${name} ${scopeName}`}>
          <Select value={scope} disabled={scopes === undefined} onChange={(event) => setScope(event.target.value)}>
            {scopes === undefined && <option value="">Loading {scopeName}s…</option>}
            {scopes?.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name} ({s.key})
              </option>
            ))}
          </Select>
        </Field>
      )}
      {errorLine}
    </Dialog>
  );
}
