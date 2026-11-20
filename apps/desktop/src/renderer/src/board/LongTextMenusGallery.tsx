import type { ReactNode } from 'react';
import { ZONE_COLORS, type LibraryPrefab, type PrefabMember, type Zone } from '@agent-board/daemon/protocol';
import { Copy, FolderGit2, Hash, Pencil, Trash2 } from 'lucide-react';
import { SpotlightResult } from '../chrome/Spotlight';
import type { SpotlightRow } from '../chrome/spotlight-results';
import { CrewPromptDialog } from '../crews/CrewPromptDialog';
import { NewTicketDialog } from '../crews/NewTicketDialog';
import { Button, Dialog, ErrorText, Hint, MenuPreview, Readout, type MenuEntry } from '../ui';
import { longAgent } from './LongTextGallery';
import { CrewSheetRow, NewSheetTitle } from './NewAgentDialog';
import { EMOJI, LONG_PATH, LONG_SENTENCE, LONG_URL, NO_SPACES, OTHER_SCRIPTS } from './long-text';

const noop = () => {};

/** A menu with long text in every kind of row: a heading, labels, muted words, a hint, a badge, a choice, a submenu. */
const MENU: MenuEntry[] = [
  { heading: LONG_PATH },
  { label: NO_SPACES, icon: <Pencil />, shortcut: '⌘R', onSelect: noop },
  { label: `Issues from ${LONG_URL}…`, icon: <Hash />, detail: LONG_PATH, onSelect: noop },
  { label: OTHER_SCRIPTS, icon: <FolderGit2 />, badge: 'new', onSelect: noop },
  { label: EMOJI, checked: true, onSelect: noop },
  { label: LONG_SENTENCE, icon: <Copy />, hint: NO_SPACES, onSelect: noop },
  { label: `Duplicate ${NO_SPACES} to change it`, entries: [], detail: EMOJI },
  'separator',
  { label: 'Delete zone…', icon: <Trash2 />, danger: true, hint: LONG_URL, onSelect: noop },
];

/** A menu in a box of a width the board gives it, drawn in place rather than over the window. */
function MenuBox({ width }: { width: number }) {
  return (
    <div className="long-text-box long-text-menu" style={{ width }} data-testid="long-text-box">
      <MenuPreview entries={MENU} active={NO_SPACES} />
    </div>
  );
}

const zoneNamed = (id: string, name: string) => ({ id, name, color: ZONE_COLORS[0], repoRoot: LONG_PATH, defaultRepo: null, clone: null, x: 0, y: 0 }) as unknown as Zone;
const LONG_ZONE = zoneNamed('long-zone', NO_SPACES);

const agentRow = (key: string, text: string): SpotlightRow => ({ key, subject: { kind: 'agent', agent: longAgent(key, text) }, name: text, sub: LONG_PATH, marks: [0, 1, 2] });
/** ⌘K's rows, of every kind that shows text from the board, each with long text. */
const SPOTLIGHT: SpotlightRow[] = [
  agentRow('agent', NO_SPACES),
  { ...agentRow('purpose', OTHER_SCRIPTS), sub: LONG_SENTENCE, purpose: true },
  { ...agentRow('snippet', EMOJI), snippet: { label: 'PR', text: LONG_URL, marks: [4, 5] } },
  { key: 'zone', subject: { kind: 'zone', zone: LONG_ZONE }, name: NO_SPACES, sub: LONG_PATH, marks: [] },
  { key: 'pr', subject: { kind: 'pr', pr: { repo: NO_SPACES, number: 12345, url: LONG_URL } }, name: LONG_SENTENCE, sub: NO_SPACES, marks: [] },
  { key: 'web', subject: { kind: 'web', url: LONG_URL }, name: LONG_URL, sub: LONG_URL, marks: [] },
  { key: 'crew', subject: { kind: 'crew', prefab: NO_SPACES }, name: NO_SPACES, sub: LONG_SENTENCE, marks: [] },
];

/** ⌘K's list as wide as the switcher: its rows full, then two columns of compact ones side by side. */
function SpotlightBox() {
  return (
    <div className="long-text-box long-text-spotlight" style={{ width: 520 }} data-testid="long-text-box">
      <div className="spotlight-list" role="listbox" aria-label="Long rows">
        {SPOTLIGHT.map((row) => (
          <SpotlightResult key={row.key} id={`long-${row.key}`} row={row} active={row.key === 'agent'} onHover={noop} onPick={noop} />
        ))}
        <div className="spotlight-columns" role="presentation">
          {[0, 1].map((column) => (
            <div key={column} className="spotlight-column" role="presentation">
              {SPOTLIGHT.slice(0, 3).map((row) => (
                <SpotlightResult key={row.key} id={`long-${column}-${row.key}`} row={row} active={false} compact onHover={noop} onPick={noop} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const member = (id: string, fields: Partial<PrefabMember> = {}): PrefabMember => ({
  id,
  role: 'implementer',
  name: NO_SPACES,
  harness: 'claude',
  model: NO_SPACES,
  effort: null,
  template: null,
  subagents: [],
  starts: 'prompt',
  ...fields,
});
const PREFAB: LibraryPrefab = {
  name: NO_SPACES,
  icon: 'review',
  purpose: LONG_SENTENCE,
  roundLimit: 3,
  onBoard: 'card',
  builtIn: false,
  editedAt: null,
  members: [member('builder'), member('review', { role: 'reviewer', starts: 'handoff' })],
};
const TICKET_PREFAB: LibraryPrefab = { ...PREFAB, onBoard: 'ticket', ticketChat: 'implementer' };

/** A dialog in a box of a dialog's width, drawn in place. */
function DialogBox({ children }: { children: ReactNode }) {
  return (
    <div className="long-text-box long-text-dialog" data-testid="long-text-box">
      {children}
    </div>
  );
}

/**
 * Menus, ⌘K's rows, dialogs and the controls Settings is made of, with long text in every field: nothing in them may run
 * past its box. The app shows it at `#gallery-long-text-menus`.
 */
export function LongTextMenusGallery() {
  return (
    <section className="long-text-gallery" data-testid="long-text-gallery" aria-label="Long text in menus and dialogs">
      <div className="long-text-gallery-row">
        <MenuBox width={260} />
        <MenuBox width={520} />
        <SpotlightBox />
      </div>
      <div className="long-text-gallery-row">
        <DialogBox>
          <Dialog
            inline
            aria-label="New agent"
            title={<NewSheetTitle zone={LONG_ZONE} />}
            onClose={noop}
            footer={<Button variant="ghost">Cancel</Button>}
          >
            <p>{LONG_URL}</p>
            <Hint>No repo: runs in {LONG_PATH}. Agents it starts pick their repo per task.</Hint>
            <ErrorText>{NO_SPACES}</ErrorText>
            <ul className="new-crew-list" aria-label="Crew prefabs">
              <li>
                <CrewSheetRow prefab={PREFAB} onPick={noop} />
              </li>
              <li>
                <CrewSheetRow prefab={{ ...PREFAB, name: OTHER_SCRIPTS, builtIn: true }} onPick={noop} />
              </li>
            </ul>
          </Dialog>
        </DialogBox>
        <DialogBox>
          <CrewPromptDialog prefab={PREFAB} zones={[LONG_ZONE]} zone={LONG_ZONE} onAddZone={noop} onStarted={noop} onCancel={noop} inline />
        </DialogBox>
        <DialogBox>
          <NewTicketDialog prefabs={[TICKET_PREFAB]} zones={[LONG_ZONE]} zone={LONG_ZONE} onAddZone={noop} onStarted={noop} onCancel={noop} inline />
        </DialogBox>
        <div className="long-text-box" style={{ width: 360 }} data-testid="long-text-box">
          <Readout label="Version">{LONG_PATH}</Readout>
          <Hint>{LONG_URL}</Hint>
        </div>
      </div>
    </section>
  );
}
