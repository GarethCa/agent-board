import { useState } from 'react';
import type { CrewPrefab, LibraryPrefab, Zone } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { useToast } from '../ui';
import { CrewPromptDialog } from './CrewPromptDialog';
import { PrefabEditor } from './PrefabEditor';
import { PrefabsDialog } from './PrefabsDialog';
import { currentPrefabs, refreshPrefabs } from './prefab-store';

/** Where the crew dialogs open: the library, or the prompt box of the prefab named, in a zone if one is meant. */
export type CrewFlowStart = ({ kind: 'library' } | { kind: 'prompt'; prefab: LibraryPrefab }) & {
  /** The zone it was asked from: its crew starts there, and the prompt box says so. */
  zone?: Zone;
  /** With no such zone, the one the prompt box's Zone starts on: nearest what was clicked, or in view. */
  suggested?: Zone;
  /** Opened from New agent's Crew, which closing goes back to, with the place on the board it was opened for, if any. */
  fromSheet?: { position?: { x: number; y: number } };
};

type Step = { kind: 'library' } | { kind: 'prompt'; prefab: LibraryPrefab } | { kind: 'edit'; prefab: LibraryPrefab | null; imported?: CrewPrefab };

interface CrewFlowProps {
  start: CrewFlowStart;
  /** The zones a crew can start in. */
  zones: readonly Zone[];
  /** The crew started: its first member's session. */
  onStarted(sessionId: string): void;
  onClose(): void;
  /** There is no zone to start in, and the user asked to add one. */
  onAddZone(): void;
}

/**
 * The crew dialogs, one at a time: the library, a prefab's prompt box, and its flow editor. From the library, each goes
 * back to it; opened on a prompt box, closing it closes them all.
 */
export function CrewFlow({ start, zones, onStarted, onClose, onAddZone }: CrewFlowProps) {
  const [step, setStep] = useState<Step>(start.kind === 'library' ? { kind: 'library' } : { kind: 'prompt', prefab: start.prefab });
  const toasts = useToast();
  const back = () => (start.kind === 'library' ? setStep({ kind: 'library' }) : onClose());

  if (step.kind === 'prompt') {
    return <CrewPromptDialog prefab={step.prefab} zones={zones} zone={start.zone} suggested={start.suggested} onAddZone={onAddZone} onStarted={onStarted} onCancel={back} />;
  }
  if (step.kind === 'edit') {
    return (
      <PrefabEditor
        prefab={step.prefab}
        imported={step.imported}
        onClose={back}
        onSaved={() => void refreshPrefabs()}
      />
    );
  }
  const importFile = () => {
    window.agentBoard.orchestrators.importPrefab().then(
      (imported) => {
        if (imported !== null) setStep({ kind: 'edit', prefab: null, imported });
      },
      (failure: unknown) => toasts.show({ id: 'import a crew prefab', tone: 'error', message: `Could not import it: ${errorMessage(failure)}` }),
    );
  };
  return <PrefabsDialog onClose={onClose} onStart={(prefab) => setStep({ kind: 'prompt', prefab })} onEdit={(prefab) => setStep({ kind: 'edit', prefab })} onImport={importFile} />;
}

/** The prefab named `name`, as last known, for an entry point that holds only its name. */
export const prefabNamed = (name: string): LibraryPrefab | undefined => currentPrefabs().find((prefab) => prefab.name === name);
