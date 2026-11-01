import { expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// The composer under the Simplified design: one "+" menu at the field's start holds attaching an image and the commands
// worth naming, which it types for the user to send; Classic keeps its prompt, Send label and hint.

const GRADIENT = fileURLToPath(new URL('./images/gradient.png', import.meta.url));

const field = (window: Page) => sessionWindow(window).getByLabel('Message to the agent');

test('the + menu attaches an image from a picker, and types a command for the user to send', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();
    const composer = sessionWindow(window).locator('.composer');
    await expect(field(window)).toHaveAttribute('placeholder', 'Reply…');
    // No prompt glyph, Send label or hint line: the + and a round send button.
    await expect(composer.locator('.composer-prompt')).toHaveCount(0);
    await expect(composer.locator('.composer-hint')).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Send' })).toBeDisabled();

    // A press on the field's padding, off the + and the text, puts the caret in the text and opens no menu.
    const box = (await composer.locator('.composer-field').boundingBox())!;
    await window.mouse.click(box.x + box.width / 2, box.y + 2);
    await expect(field(window)).toBeFocused();
    await expect(window.getByRole('menuitem')).toHaveCount(0);

    // + → Attach an image…: the picker opens, and the image's kept path goes in the message.
    await composer.getByTestId('composer-plus').click();
    await expect(window.getByRole('menuitem')).toHaveText(['Attach an image…', 'Summarise the conversation so far', 'Change model…']);
    const chooser = window.waitForEvent('filechooser');
    await window.getByRole('menuitem', { name: 'Attach an image…' }).click();
    await (await chooser).setFiles(GRADIENT);
    await expect(field(window)).toHaveValue(/pasted-images.*\.png$/);
    const path = (await field(window).inputValue()).replace(/\\(.)/g, '$1');
    expect(existsSync(path)).toBe(true);

    // A file that is no image is refused in words, not dropped.
    await sessionWindow(window).getByTestId('composer-attach').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await expect(composer.getByText('only images can be attached')).toBeVisible();

    // With a draft, the commands wait; attaching does not.
    await composer.getByTestId('composer-plus').click();
    await expect(window.getByRole('menuitem', { name: 'Summarise the conversation so far' })).toBeDisabled();
    await expect(window.getByRole('menuitem', { name: 'Change model…' })).toBeDisabled();
    await expect(window.getByRole('menuitem', { name: 'Attach an image…' })).toBeEnabled();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('menuitem')).toHaveCount(0);

    // On an empty field a command is typed, not sent: the user presses Enter.
    await field(window).fill('');
    await composer.getByTestId('composer-plus').click();
    await window.getByRole('menuitem', { name: 'Change model…' }).click();
    await expect(field(window)).toHaveValue('/model ');
    await expect(field(window)).toBeFocused();
    await expect(sessionWindow(window).getByTestId('chat-sent')).toHaveCount(0);

    // Shift+Enter still makes a new line in the field.
    await field(window).fill('one');
    await window.keyboard.press('Shift+Enter');
    await window.keyboard.type('two');
    await expect(field(window)).toHaveValue('one\ntwo');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('under Classic the composer keeps its prompt, Send label and hint, and has no + menu', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();
    // Classic opens on the terminal; the composer is the chat's.
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const composer = sessionWindow(window).locator('.composer');
    await expect(composer.getByTestId('composer-plus')).toHaveCount(0);
    await expect(composer.getByTestId('composer-attach')).toHaveCount(0);
    await expect(composer.locator('.composer-prompt')).toBeVisible();
    await expect(composer.getByRole('button', { name: /^Send/ })).toBeVisible();
    await expect(composer.locator('.composer-hint')).toContainText('paste an image to attach it');
    await expect(field(window)).toHaveAttribute('placeholder', /^Message /);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
