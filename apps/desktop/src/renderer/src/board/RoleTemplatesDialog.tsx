import { useEffect, useRef, useState } from 'react';
import { AGENT_ROLES, TEMPLATE_VARIABLES, type AgentRole, type RoleTemplate, type Zone } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Dialog, ErrorText, Hint, Textarea } from '../ui';
import { useAction } from '../use-action';
import { ROLE_LABELS } from './AgentSetup';

/** When a template was saved, as its footer line says it. */
const editedAt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A built-in role, as against a custom role's name. */
const isBuiltIn = (role: string): role is AgentRole => AGENT_ROLES.includes(role as AgentRole);

/** A role as the dialog names it: a built-in by its label, a named role by its name. */
const roleName = (role: string) => (isBuiltIn(role) ? ROLE_LABELS[role] : role);

/**
 * A zone's role templates (BK2), from its tab's ⋯ › Role templates…: the roles on the left, the picked one's
 * template on the right, with its variables to insert, Reset to the repo's (its worker prompt, else the app's own) and
 * Save. Each role's edits are kept while another is looked at; Save saves every one changed. Below the built-in roles,
 * the named roles used in the zone or among the app's default roles, each reset to the app's default.
 */
export function RoleTemplatesDialog({ zone, onClose }: { zone: Zone; onClose(): void }) {
  const [templates, setTemplates] = useState<RoleTemplate[]>();
  const [loadError, setLoadError] = useState<string>();
  const [picked, setPicked] = useState<string>('implementer');
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const editor = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    window.agentBoard.zones.roleTemplates(zone.id).then(setTemplates, (failure: unknown) => setLoadError(errorMessage(failure)));
  }, [zone.id]);

  const template = templates?.find((each) => each.role === picked);
  const body = drafts[picked] ?? template?.body ?? '';
  const changed = (templates ?? []).filter((each) => drafts[each.role] !== undefined && drafts[each.role] !== each.body);
  const replace = (saved: RoleTemplate) => {
    setTemplates((current) => current?.map((each) => (each.role === saved.role ? saved : each)));
    setDrafts((current) => ({ ...current, [saved.role]: undefined }));
  };

  /** Puts `{{name}}` where the caret is, replacing any selection, and keeps typing after it. */
  const insert = (name: string) => {
    const field = editor.current;
    const text = `{{${name}}}`;
    const start = field?.selectionStart ?? body.length;
    const end = field?.selectionEnd ?? body.length;
    setDrafts((current) => ({ ...current, [picked]: body.slice(0, start) + text + body.slice(end) }));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const save = () =>
    run(
      () => Promise.all(changed.map((each) => window.agentBoard.zones.setRoleTemplate(zone.id, each.role, drafts[each.role]!))),
      (saved) => {
        saved.forEach(replace);
        onClose();
      },
    );
  const reset = () => run(() => window.agentBoard.zones.resetRoleTemplate(zone.id, picked), replace);

  const roleLabel = (role: string) => (role === 'custom' ? '+ Custom role' : roleName(role));
  const builtIn = isBuiltIn(picked);
  const source = (each: RoleTemplate) =>
    each.seed !== null
      ? `Seeded from ${each.seed}`
      : isBuiltIn(each.role)
        ? "The app's own template"
        : each.appDefault
          ? "The app's default role"
          : 'Empty until saved';
  const seedLine =
    template === undefined ? '' : [source(template), template.editedAt && `edited ${editedAt(template.editedAt)}`].filter(Boolean).join(' · ');

  return (
    <Dialog
      aria-label="Role templates"
      title={`Role templates · ${zone.name}`}
      onClose={onClose}
      footerStart={
        <Button variant="ghost" disabled={busy || template?.editedAt == null} onClick={reset}>
          {builtIn ? "Reset to the repo's" : "Reset to the app's"}
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={changed.length === 0} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {templates === undefined ? (
        loadError === undefined ? <Hint>Loading…</Hint> : <ErrorText>{loadError}</ErrorText>
      ) : (
        <div className="role-templates-body">
          <div className="role-templates-roles" role="tablist" aria-label="Roles" aria-orientation="vertical">
            {templates.map(({ role }) => (
              <button
                key={role}
                type="button"
                role="tab"
                className="role-templates-role"
                aria-selected={role === picked}
                onClick={() => setPicked(role)}
              >
                {roleLabel(role)}
                {drafts[role] !== undefined && drafts[role] !== templates.find((each) => each.role === role)?.body && ' •'}
              </button>
            ))}
          </div>
          <div className="role-templates-editor" role="tabpanel" aria-label={roleName(picked)}>
            <div className="role-templates-insert">
              <span className="role-templates-insert-label">Insert:</span>
              {TEMPLATE_VARIABLES.map((name) => (
                <button key={name} type="button" className="role-templates-variable" onClick={() => insert(name)}>
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
            <Textarea
              ref={editor}
              aria-label={`${roleName(picked)} template`}
              className="role-templates-text"
              rows={14}
              spellCheck={false}
              value={body}
              placeholder={builtIn && picked !== 'custom' ? undefined : `What an agent in ${picked === 'custom' ? 'a custom role' : picked} starts with…`}
              onChange={(event) => setDrafts((current) => ({ ...current, [picked]: event.target.value }))}
            />
            <Hint>{seedLine}</Hint>
          </div>
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
