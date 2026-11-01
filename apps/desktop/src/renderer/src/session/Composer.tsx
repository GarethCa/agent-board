import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { ArrowUp, Plus } from 'lucide-react';
import { Button, ErrorText, IconButton, Kbd, Menu, Textarea } from '../ui';
import { useSimplified } from '../design';
import { errorMessage } from '../../../shared/errors';
import { agentAtWork } from './chat';
import { composerBlock, composerPlaceholder } from './composer-block';
import { composerExtras } from './composer-extras';
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
 * pastes a dropped file. Under the Simplified design (docs/adr/0022-simplified-design.md) a "+" menu at the field's start
 * holds the extras: attaching an image, and the commands worth naming, which it types for the user to send.
 */
export function Composer({ agent, placeholder, focusRequest }: ComposerProps) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Set by a command typed from the menu: the menu then leaves focus in the field, not on its button.
  const focusField = useRef(false);
  const simplified = useSimplified();
  const Field = simplified ? 'div' : 'label';
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
  /** Keeps `files`' images where the agent can read them and puts their paths in the message, at the caret. */
  const keepImages = (files: File[]) => {
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
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    keepImages(files);
  };
  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])];
    const files = picked.filter((file) => file.type.startsWith('image/'));
    // Cleared so picking the same file again still changes the input.
    event.target.value = '';
    if (files.length > 0) keepImages(files);
    else if (picked.length > 0) setPasteError('only images can be attached');
  };
  const typeCommand = (command: string) => {
    setText(command);
    focusField.current = true;
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Field
        className="composer-field"
        // Under the Simplified design the field is no label (its first control would be the "+"): a press on its padding focuses the text.
        {...(simplified && {
          onMouseDown: (event: MouseEvent<HTMLElement>) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            field.current?.focus();
          },
        })}
      >
        {simplified ? (
          <>
            <Menu
              align="start"
              side="top"
              onCloseFocus={(event) => {
                if (!focusField.current) return;
                focusField.current = false;
                event.preventDefault();
                const box = field.current;
                box?.focus();
                box?.setSelectionRange(box.value.length, box.value.length);
              }}
              entries={composerExtras({ onAttach: () => picker.current?.click(), onCommand: typeCommand, draft: text })}
            >
              <IconButton className="composer-plus" icon={<Plus />} aria-label="Add to the message" data-testid="composer-plus" disabled={blocked !== undefined} />
            </Menu>
            <input ref={picker} type="file" accept="image/*" multiple hidden data-testid="composer-attach" onChange={onPicked} />
          </>
        ) : (
          <span className="composer-prompt" aria-hidden>
            &gt;
          </span>
        )}
        <Textarea
          ref={field}
          className="composer-input"
          aria-label="Message to the agent"
          placeholder={simplified ? composerPlaceholder(agent, placeholder) : (blocked?.reason ?? placeholder ?? `Message ${agent.name}…`)}
          rows={1}
          value={text}
          disabled={blocked !== undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {blocked === undefined &&
          (simplified ? (
            <IconButton type="submit" className="composer-send" variant="primary" icon={<ArrowUp />} aria-label="Send" tooltip={keyText('window.send')} loading={pasting} disabled={text.trim() === ''} />
          ) : (
            <Button type="submit" size="sm" variant="primary" loading={pasting} disabled={text.trim() === ''}>
              Send
              <Kbd className="composer-key">{keyText('window.send')}</Kbd>
            </Button>
          ))}
      </Field>
      {blocked === undefined && !simplified && (
        <p className="composer-hint">
          <Kbd>{keyText('window.newLine')}</Kbd> new line · paste an image to attach it
        </p>
      )}
      {pasteError && <ErrorText className="composer-error">{pasteError}</ErrorText>}
    </form>
  );
}
