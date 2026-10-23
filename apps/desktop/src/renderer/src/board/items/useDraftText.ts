import { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { ItemNodeType } from './items';

/** How long typing pauses before what was typed is saved, ms. */
const SAVE_PAUSE_MS = 400;

/**
 * The text of an item being edited in place, for sticky notes, text items and shapes. `save` writes `text` back (it
 * may also save what the text sizes, so it may change between renders). What is typed is saved when typing pauses,
 * when editing ends (blur or Escape), and when the window goes. An item with several texts, as a class has its
 * sections, names the one being typed in by `which`: a new one starts from its own `text`, once what was typed in the
 * last is saved (`flush`, while `save` still writes that one).
 */
export function useDraftText(nodeId: string, editing: boolean, text: string, save: (text: string) => void, which: string | number = 0) {
  const { updateNodeData } = useReactFlow<ItemNodeType>();
  // What is being typed, while editing: the text shown. It is the editor's own, so a change saved (or echoed back)
  // meanwhile never overwrites what is being typed.
  const [draft, setDraft] = useState(text);
  /** The draft, for saving from timers and listeners. */
  const draftRef = useRef(draft);
  /**
   * The text as this editor last saved it, or found it when editing began. Only a draft that differs is saved, so an
   * editor left untouched never writes back text another window has changed since.
   */
  const savedText = useRef(text);
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback(() => {
    clearTimeout(pause.current);
    if (draftRef.current === savedText.current) return;
    savedText.current = draftRef.current;
    saveRef.current(draftRef.current);
  }, []);

  // While editing, what was typed is saved if the window goes (closed, reloaded, the app quits: no blur comes then) or
  // the editor does.
  useEffect(() => {
    if (!editing) return;
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [editing, flush]);

  // Editing begun elsewhere (Enter on a selected shape), or moved to another of the item's texts, starts from the text
  // as it is now, before the first render of the editor: that is drawn, and measured, with the text and not what was
  // typed last time.
  const typingIn = editing ? which : null;
  const [wasTypingIn, setWasTypingIn] = useState(typingIn);
  if (typingIn !== wasTypingIn) {
    setWasTypingIn(typingIn);
    if (editing) {
      setDraft(text);
      draftRef.current = text;
      savedText.current = text;
    }
  }

  const startEditing = () => {
    setDraft(text);
    draftRef.current = text;
    savedText.current = text;
    updateNodeData(nodeId, { editing: true });
  };
  const type = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    clearTimeout(pause.current);
    pause.current = setTimeout(flush, SAVE_PAUSE_MS);
  };
  const finishEditing = () => {
    flush();
    updateNodeData(nodeId, { editing: false });
  };

  return {
    shown: editing ? draft : text,
    draft,
    flush,
    startEditing,
    type,
    finishEditing,
  };
}
