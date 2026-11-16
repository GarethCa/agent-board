import { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { AnchoredPopover, Button, ErrorText, Input, type Measured } from '../ui';
import { PrefabIcon } from './icons';
import { agentPrefab, agentRole } from './prefab-board';
import { PREFAB_ICONS, type PrefabBoardStart } from './PrefabBoard';
import { MAX_PREFAB_NAME } from './prefab-flow';
import { refreshPrefabs } from './prefab-store';

const ICON_NAMES: Record<string, string> = { bug: 'Bug', ticket: 'Ticket', crew: 'Crew', palette: 'Palette', review: 'Review', rocket: 'Rocket' };

/** The id of the one member a prefab saved from a tile has, which its board opens on selected. */
const MEMBER = 'agent';

interface SaveAsPrefabProps {
  agent: Agent;
  onClose(): void;
  /** Saved: open it on its board. */
  onSaved(start: PrefabBoardStart): void;
}

/**
 * Save as prefab…, from an agent's tile: beside the tile, a name and an icon, what the prefab keeps of the agent (its
 * name, role, AI, model and reasoning, starting on your prompt) and what it leaves behind (its chat and first message,
 * its ticket, branch and repo). Save saves it at once and opens it on its own board, to change anything there.
 */
export function SaveAsPrefab({ agent, onClose, onSaved }: SaveAsPrefabProps) {
  const [name, setName] = useState(agent.name.slice(0, MAX_PREFAB_NAME));
  const [icon, setIcon] = useState('crew');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const role = agentRole(agent);
  const own = agent.role === 'custom' && role !== null;
  // A role of its own brings its prompt, as its zone has it; a built-in role's is each zone's.
  const [template, setTemplate] = useState<string | null>(null);
  // Save waits for it, so a quick Save never leaves out the prompt it is about to say it keeps.
  const [loading, setLoading] = useState(own && agent.zoneId !== null);
  useEffect(() => {
    if (!own || agent.zoneId === null) return;
    let live = true;
    window.agentBoard.zones.roleTemplates(agent.zoneId).then(
      (templates) => {
        if (!live) return;
        setTemplate(templates.find((each) => each.role.toLowerCase() === role.toLowerCase())?.body ?? null);
        setLoading(false);
      },
      () => live && setLoading(false),
    );
    return () => {
      live = false;
    };
  }, [own, agent.zoneId, role]);
  const tile = useRef<Measured>({
    getBoundingClientRect: () => (document.querySelector(`[data-session-id="${CSS.escape(agent.sessionId)}"]`) ?? document.body).getBoundingClientRect(),
  });

  const save = async () => {
    if (name.trim() === '') {
      setError('Name it.');
      return;
    }
    setBusy(true);
    try {
      const done = await window.agentBoard.orchestrators.savePrefab(agentPrefab(agent, { name: name.trim(), icon, template }));
      void refreshPrefabs();
      onSaved({ prefab: done, replaces: done.name, select: MEMBER, toast: 'Saved. Change anything here, or Esc to go back.' });
    } catch (failure) {
      setError(`Could not save it: ${errorMessage(failure)}`);
      setBusy(false);
    }
  };

  const model = [agent.harness, agent.model, agent.effort].filter((part) => part !== null).join(' · ');
  const roleWords = role === null ? 'no role' : own && template !== null ? `role ${role} and its prompt` : `role ${role === 'implementer' ? 'builder' : role}`;
  const ticket = agent.issue === null ? 'its ticket' : agent.issue.id;
  return (
    <AnchoredPopover anchor={{ measured: tile }} aria-label="Save as prefab" open onOpenChange={(open) => !open && onClose()} side="right" align="start" className="save-prefab">
      <form
        className="save-prefab-form"
        data-testid="save-as-prefab"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="save-prefab-title">
          <Users aria-hidden />
          Save as prefab
        </h2>
        <label className="prefab-side-field">
          <span className="prefab-side-label">Name</span>
          <Input
            aria-label="Prefab name"
            value={name}
            maxLength={MAX_PREFAB_NAME}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
          />
        </label>
        <span className="prefab-icon-row" role="radiogroup" aria-label="Icon">
          {PREFAB_ICONS.map((each) => (
            <button key={each} type="button" role="radio" aria-checked={each === icon} aria-label={ICON_NAMES[each]} title={ICON_NAMES[each]} onClick={() => setIcon(each)}>
              <PrefabIcon icon={each} />
            </button>
          ))}
        </span>
        <div className="save-prefab-lists">
          <span className="prefab-side-label">It keeps</span>
          <ul className="save-prefab-keeps">
            <li>{agent.name.trim() === '' ? 'One agent' : `One agent, called ${agent.name}`}</li>
            <li>{roleWords}</li>
            <li className="save-prefab-mono">{model}</li>
            <li>starts on your prompt</li>
          </ul>
          <span className="prefab-side-label">It leaves behind</span>
          <ul className="save-prefab-leaves">
            <li>this chat and your first message</li>
            <li>{ticket}, its branch and repo</li>
          </ul>
        </div>
        {error !== undefined && <ErrorText>{error}</ErrorText>}
        <div className="save-prefab-foot">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={busy || loading} data-testid="save-as-prefab-save">
            Save
          </Button>
        </div>
      </form>
    </AnchoredPopover>
  );
}
