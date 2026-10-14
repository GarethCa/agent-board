import { useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Zone } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Dialog, ErrorText, Hint } from '../ui';
import { FolderLine, FolderRow, useRecentFolders } from './RecentFolders';

interface DefaultRepoDialogProps {
  zone: Zone;
  onSaved(zone: Zone): void;
  onCancel(): void;
}

/**
 * A group's default repo (AJ2): a recent repo or one browsed for, that agents started in the group use without
 * asking; "Always ask" clears it, so each new agent gets the repo picker. It doesn't bind the group.
 */
export function DefaultRepoDialog({ zone, onSaved, onCancel }: DefaultRepoDialogProps) {
  const { folders, error: loadError } = useRecentFolders();
  const [picked, setPicked] = useState<string | null>(zone.defaultRepo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = (path: string | null) => {
    setBusy(true);
    setError(undefined);
    window.agentBoard.zones.setDefaultRepo(zone.id, path).then(onSaved, (failure: unknown) => {
      setError(errorMessage(failure));
      setBusy(false);
    });
  };

  const browse = () => {
    window.agentBoard.zones.browseFolder(`Default repo for ${zone.name}`).then(
      (path) => path === undefined || setPicked(path),
      (failure: unknown) => setError(errorMessage(failure)),
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save(picked);
  };

  // The picked repo heads the list even when it isn't a recent one (browsed for, or set before).
  const listed = folders ?? [];
  const rows = picked !== null && !listed.some((folder) => folder.path === picked) ? [{ path: picked, branch: null }, ...listed] : listed;

  return (
    <Dialog
      aria-label="Default repo"
      title={`Default repo for ${zone.name}`}
      onClose={onCancel}
      onSubmit={submit}
      footerStart={
        <Button variant="ghost" disabled={busy} onClick={() => save(null)}>
          Always ask
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={picked === null}>
            Save
          </Button>
        </>
      }
    >
      <Hint>
        New agents started here use it without asking. Agents you drag in keep their own repo. It doesn&apos;t make this a
        bound zone.
      </Hint>
      {folders === undefined && loadError === undefined && <Hint>Loading…</Hint>}
      <ul className="add-zone-list" role="listbox" aria-label="Repos">
        {rows.map((folder) => (
          <FolderRow key={folder.path} picked={picked === folder.path} onPick={() => setPicked(folder.path)}>
            <FolderLine path={folder.path} branch={folder.branch} />
          </FolderRow>
        ))}
      </ul>
      <Button variant="ghost" icon={<FolderOpen />} onClick={browse}>
        Browse…
      </Button>
      {(error ?? loadError) !== undefined && <ErrorText>{error ?? loadError}</ErrorText>}
    </Dialog>
  );
}
