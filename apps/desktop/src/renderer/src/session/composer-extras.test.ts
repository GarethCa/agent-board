import { describe, expect, it, vi } from 'vitest';
import type { MenuAction } from '../ui';
import { composerExtras } from './composer-extras';

const actions = (entries: ReturnType<typeof composerExtras>) => entries.filter((entry): entry is MenuAction => typeof entry === 'object' && 'onSelect' in entry);

describe('the composer\'s "+" menu', () => {
  const handlers = () => ({ onAttach: vi.fn(), onCommand: vi.fn() });

  it('holds attaching an image, summarising the conversation and changing the model, in that order', () => {
    const entries = composerExtras({ ...handlers(), draft: '' });
    expect(actions(entries).map((entry) => entry.label)).toEqual(['Attach an image…', 'Summarise the conversation so far', 'Change model…']);
    expect(entries[1]).toBe('separator');
  });

  it('types the harness command into the field for the user to send, never sends it', () => {
    const { onAttach, onCommand } = handlers();
    const [attach, summarise, model] = actions(composerExtras({ onAttach, onCommand, draft: '' }));
    attach!.onSelect();
    summarise!.onSelect();
    model!.onSelect();
    expect(onAttach).toHaveBeenCalledOnce();
    expect(onCommand.mock.calls).toEqual([['/compact'], ['/model ']]);
  });

  it('leaves a draft alone: the commands wait for an empty field, attaching does not', () => {
    const [attach, summarise, model] = actions(composerExtras({ ...handlers(), draft: 'Fix the login' }));
    expect(attach!.disabled).toBeFalsy();
    expect(summarise!.disabled).toBe(true);
    expect(model!.disabled).toBe(true);
    expect(summarise!.hint).toBe('Clear the message first');
  });
});
