import { useState } from 'react';
import type { CrewPrefab, LibraryPrefab, Zone } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { useToast } from '../ui';
import { CrewPromptDialog } from './CrewPromptDialog';
import { DescribeCrewDialog, type DrafterChoice } from './DescribeCrewDialog';
import { NewTicketDialog } from './NewTicketDialog';
import { PrefabsDialog } from './PrefabsDialog';
import { libraryBoard, newPrefab } from './prefab-board';
import type { PrefabBoardStart } from './PrefabBoard';
import { currentPrefabs } from './prefab-store';

/** Where the crew dialogs open: the library, or the prompt box of the prefab named, in a zone if one is meant. */
export type CrewFlowStart = ({ kind: 'library' } | { kind: 'prompt'; prefab: LibraryPrefab } | { kind: 'ticket' } | { kind: 'describe' }) & {
  /** The zone it was asked from: its crew starts there, and the prompt box says so. */
  zone?: Zone;
  /** With no such zone, the one the prompt box's Zone starts on: nearest what was clicked, or in view. */
  suggested?: Zone;
  /** Opened from New agent's Crew, which closing goes back to, with the place on the board it was opened for, if any. */
  fromSheet?: { position?: { x: number; y: number } };
};

type Step = { kind: 'library' } | { kind: 'ticket'; prefab?: string } | { kind: 'prompt'; prefab: LibraryPrefab } | { kind: 'describe' };

interface CrewFlowProps {
  start: CrewFlowStart;
  /** The zones a crew can start in. */
  zones: readonly Zone[];
  /** The agents on the board that may draft a crew described. */
  agents?: readonly DrafterChoice[];
  /** The crew started: its first member's session. */
  onStarted(sessionId: string): void;
  onClose(): void;
  /** There is no zone to start in, and the user asked to add one. */
  onAddZone(): void;
  /** Open a prefab on its own board, to change it; the dialogs close. */
  onEdit(start: PrefabBoardStart): void;
}

/** What a prefab opens on its board as: one of the library's, a new one, or one read from a file (saved as new). */
export function editStart(prefab: LibraryPrefab | null, imported?: CrewPrefab): PrefabBoardStart {
  if (imported !== undefined) return { prefab: imported, replaces: null };
  if (prefab === null) return { prefab: newPrefab(), replaces: null };
  return libraryBoard(prefab);
}

/**
 * The crew dialogs, one at a time: the library and a prefab's prompt box. From the library, each goes back to it; opened
 * on a prompt box, closing it closes them all. Changing a prefab opens it on its own board, closing them.
 */
export function CrewFlow({ start, zones, agents = [], onStarted, onClose, onAddZone, onEdit }: CrewFlowProps) {
  const [step, setStep] = useState<Step>(start.kind === 'prompt' ? { kind: 'prompt', prefab: start.prefab } : start.kind === 'library' ? { kind: 'library' } : { kind: start.kind });
  const toasts = useToast();
  const back = () => (start.kind === 'library' ? setStep({ kind: 'library' }) : onClose());

  // A prefab that starts inside a ticket tile starts from the New ticket sheet, on that prefab.
  if (step.kind === 'ticket' || (step.kind === 'prompt' && step.prefab.onBoard === 'ticket')) {
    const picked = step.kind === 'prompt' ? step.prefab.name : step.prefab;
    return (
      <NewTicketDialog
        prefabs={currentPrefabs()}
        {...(picked === undefined ? {} : { prefab: picked })}
        zones={zones}
        zone={start.zone}
        {...(start.suggested === undefined ? {} : { suggested: start.suggested })}
        onAddZone={onAddZone}
        onStarted={onStarted}
        onCancel={back}
      />
    );
  }
  if (step.kind === 'describe') {
    return <DescribeCrewDialog zones={zones} {...(start.zone === undefined ? {} : { zone: start.zone })} {...(start.suggested === undefined ? {} : { suggested: start.suggested })} agents={agents} onClose={back} />;
  }
  if (step.kind === 'prompt') {
    return <CrewPromptDialog prefab={step.prefab} zones={zones} zone={start.zone} suggested={start.suggested} onAddZone={onAddZone} onStarted={onStarted} onCancel={back} />;
  }
  const importFile = () => {
    window.agentBoard.orchestrators.importPrefab().then(
      (imported) => {
        if (imported !== null) onEdit(editStart(null, imported));
      },
      (failure: unknown) => toasts.show({ id: 'import a crew prefab', tone: 'error', message: `Could not import it: ${errorMessage(failure)}` }),
    );
  };
  return (
    <PrefabsDialog
      onClose={onClose}
      onStart={(prefab) => setStep({ kind: 'prompt', prefab })}
      onEdit={(prefab) => onEdit(editStart(prefab))}
      onDescribe={() => setStep({ kind: 'describe' })}
      onImport={importFile}
    />
  );
}

/** The prefab named `name`, as last known, for an entry point that holds only its name. */
export const prefabNamed = (name: string): LibraryPrefab | undefined => currentPrefabs().find((prefab) => prefab.name === name);
