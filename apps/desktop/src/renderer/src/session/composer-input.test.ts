import { describe, expect, test } from 'vitest';
import { composerKey, droppedPath, insertAt } from './composer-input';

const key = (init: Partial<Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing'>>) =>
  composerKey({ key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...init });

describe("the composer's keys", () => {
  test('Enter sends', () => {
    expect(key({})).toBe('send');
  });

  test('Shift+Enter and Option+Enter make a new line, as in the terminal', () => {
    expect(key({ shiftKey: true })).toBe('newline');
    expect(key({ altKey: true })).toBe('newline');
  });

  test('Enter that ends an input method composition, other keys and other modifiers are left to the box', () => {
    expect(key({ isComposing: true })).toBeUndefined();
    expect(key({ key: 'a' })).toBeUndefined();
    expect(key({ metaKey: true })).toBeUndefined();
    expect(key({ ctrlKey: true })).toBeUndefined();
  });
});

describe('putting a pasted image path into the message', () => {
  test('at the caret, spaced from the words either side', () => {
    expect(insertAt('Look at this', 7, 7, '/p/a.png')).toEqual({ text: 'Look at /p/a.png this', caret: 16 });
    expect(insertAt('Look at', 7, 7, '/p/a.png')).toEqual({ text: 'Look at /p/a.png', caret: 16 });
    expect(insertAt('', 0, 0, '/p/a.png')).toEqual({ text: '/p/a.png', caret: 8 });
  });

  test('over the selection', () => {
    expect(insertAt('see THIS please', 4, 8, '/p/a.png')).toEqual({ text: 'see /p/a.png please', caret: 12 });
  });
});

describe("a pasted image's path", () => {
  test('is escaped as a terminal pastes a dropped file, so a space does not split it', () => {
    expect(droppedPath('/data/Library/Application Support/agent-board/pasted-images/ab12.png')).toBe(
      '/data/Library/Application\\ Support/agent-board/pasted-images/ab12.png',
    );
    expect(droppedPath("/tmp/it's (1).png")).toBe("/tmp/it\\'s\\ \\(1\\).png");
    expect(droppedPath('/tmp/plain-name_2.png')).toBe('/tmp/plain-name_2.png');
    expect(droppedPath('/srv/josé/Ünïcode 日本/a.png')).toBe('/srv/josé/Ünïcode\\ 日本/a.png');
  });
});
