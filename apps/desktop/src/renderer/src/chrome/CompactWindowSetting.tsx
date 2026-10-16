import { useEffect, useState } from 'react';
import { COMPACT_WINDOW_RANGE } from '@agent-board/daemon/protocol';
import { Field, Input, Select } from '../ui';

type OnError = (action: string) => (error: unknown) => void;

/** The presets Settings offers; any other window is a custom one. */
const PRESETS = [200_000, 400_000];
const { min: MIN_TOKENS, max: MAX_TOKENS } = COMPACT_WINDOW_RANGE;

/**
 * The context size Claude agents compact at, passed to the Claude sessions agent-board starts as
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Off, the default, passes nothing. Codex has no such setting.
 */
export function CompactWindowSetting({ onError }: { onError: OnError }) {
  const [saved, setSaved] = useState<number>();
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');

  const adopt = (window: number) => {
    setSaved(window);
    setCustom(window !== 0 && !PRESETS.includes(window));
    setText(window === 0 ? '' : String(window));
  };

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then((settings) => adopt(settings.compactWindow), onError('read the compact window'));
  }, [onError]);

  const save = (compactWindow: number) => {
    window.agentBoard.flowEdges.setSettings({ compactWindow }).then(
      (settings) => adopt(settings.compactWindow),
      (error: unknown) => {
        if (saved !== undefined) adopt(saved);
        onError('change the compact window')(error);
      },
    );
  };

  const choose = (value: string) => {
    if (value === 'custom') {
      setCustom(true);
      return;
    }
    setCustom(false);
    save(Number(value));
  };

  const saveCustom = () => {
    const tokens = Number(text.replace(/[,_\s]/g, ''));
    if (saved === undefined || tokens === saved) return;
    if (!Number.isInteger(tokens) || tokens < MIN_TOKENS || tokens > MAX_TOKENS) {
      adopt(saved);
      onError('change the compact window')(new Error(`Use a whole number of tokens from ${MIN_TOKENS} to ${MAX_TOKENS}.`));
      return;
    }
    save(tokens);
  };

  return (
    <>
      <Field
        label="Compact agents' context at"
        hint="Claude agents only; Codex has no equivalent. Lower means fewer tokens read on every call, but earlier summarising. Off leaves it to Claude Code."
      >
        <Select size="sm" value={custom ? 'custom' : String(saved ?? 0)} disabled={saved === undefined} onChange={(event) => choose(event.target.value)}>
          <option value="0">Off (default)</option>
          <option value="200000">200k tokens</option>
          <option value="400000">400k tokens</option>
          <option value="custom">Custom…</option>
        </Select>
      </Field>
      {custom && (
        <Field label="Custom window, in tokens">
          <Input
            size="sm"
            inputMode="numeric"
            value={text}
            placeholder="300000"
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onBlur={saveCustom}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
        </Field>
      )}
    </>
  );
}
