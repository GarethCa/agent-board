import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { Button, ErrorText, Kbd, Textarea } from '../ui';
import { errorMessage } from '../../../shared/errors';
import { agentAtWork } from './chat';
import { composerBlock } from './composer-block';
import { composerKey, droppedPath, insertAt } from './composer-input';
import { keyText } from '../keys/registry';
import { sentMessages } from './sent-messages';

interface ComposerProps {
  agent: Agent;
  /** What the empty field says while the agent can take a message: "Message <its name>…" by default. */
  placeholder?: string;
  /** Puts the caret in the field each time it changes to a number above 0. */
  focusRequest?: number;
}

/**
 * Sends the agent a message, as the needs-you inbox answers it: typed at its prompt and submitted. It shows in the
 * chat at once, saying how it is getting on, until the transcript has it; a failure shows there, to retry. Enter sends;
 * Shift+Enter or Option+Enter make a new line, as in its terminal, and the lines reach it as one message. A pasted
 * image is kept where the agent can read it and its path put in the message, which is then pasted, as a terminal
 * pastes a dropped file.
 */
export function Composer({ agent, placeholder, focusRequest }: ComposerProps) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const blocked = composerBlock(agent);
  // Each new request (⌘⇧M in the master's panel) puts the caret in the field.
  useEffect(() => {
    if (focusRequest !== undefined && focusRequest > 0) field.current?.focus();
  }, [focusRequest]);
  const send = () => {
    if (text.trim() === '' || blocked !== undefined || pasting) return;
    void sentMessages.send(agent.sessionId, text, images, agentAtWork(agent));
    setText('');
    setImages([]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKey(event.nativeEvent);
    if (action === undefined) return;
    event.preventDefault();
    if (action === 'send') return send();
    const box = event.currentTarget;
    box.setRangeText('\n', box.selectionStart, box.selectionEnd, 'end');
    setText(box.value);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    setPasting(true);
    setPasteError(undefined);
    void Promise.all(files.map(async (file) => droppedPath(await window.agentBoard.agents.pasteImage(await file.arrayBuffer()))))
      .then((paths) => {
        // Where the caret is now: the user may have typed on while the image was kept.
        const box = field.current;
        if (box === null) return;
        const placed = insertAt(box.value, box.selectionStart, box.selectionEnd, paths.join(' '));
        setText(placed.text);
        setImages((current) => [...current, ...paths]);
        requestAnimationFrame(() => field.current?.setSelectionRange(placed.caret, placed.caret));
      })
      .catch((problem: unknown) => setPasteError(`could not paste the image: ${errorMessage(problem)}`))
      .finally(() => setPasting(false));
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="composer-field">
        <span className="composer-prompt" aria-hidden>
          &gt;
        </span>
        <Textarea
          ref={field}
          className="composer-input"
          aria-label="Message to the agent"
          placeholder={blocked?.reason ?? placeholder ?? `Message ${agent.name}…`}
          rows={1}
          value={text}
          disabled={blocked !== undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {blocked === undefined && (
          <Button type="submit" size="sm" variant="primary" loading={pasting} disabled={text.trim() === ''}>
            Send
            <Kbd className="composer-key">{keyText('window.send')}</Kbd>
          </Button>
        )}
      </label>
      {blocked === undefined && (
        <p className="composer-hint">
          <Kbd>{keyText('window.newLine')}</Kbd> new line · paste an image to attach it
        </p>
      )}
      {pasteError && <ErrorText className="composer-error">{pasteError}</ErrorText>}
    </form>
  );
}
