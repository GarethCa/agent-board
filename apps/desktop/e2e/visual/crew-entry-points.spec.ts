// Where a crew starts from, in both designs: New agent's Crew, the board's right-click menu and ⌘K's Crews group.
import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, zoneControl } from '../agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { SHOT, needsBaselines, THEMES } from './shared.ts';

test.use({ viewport: null });

const saveBigCrew = (page: Page) =>
  page.evaluate(() =>
    window.agentBoard.orchestrators.savePrefab({
      name: 'Five crew checks',
      icon: 'crew',
      purpose: 'One builds, and five check it',
      roundLimit: 3,
      onBoard: 'card',
      members: ['impl', 'code', 'design', 'tests', 'docs', 'security'].map((id, index) => ({
        id,
        role: index === 0 ? 'implementer' : 'reviewer',
        name: null,
        harness: 'claude' as const,
        model: null,
        effort: null,
        template: null,
        starts: index === 0 ? ('prompt' as const) : ('handoff' as const),
        subagents: [],
      })),
    }),
  );

for (const { theme, suffix } of THEMES) {
  for (const design of ['classic', 'simplified'] as const) {
    const named = (shot: string) => `${shot}${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`where a crew starts from: New agent's Crew, right-click and ⌘K, ${design}, ${theme}`, async () => {
      needsBaselines(named('crew-sheet'), named('crew-right-click'), named('crew-spotlight'));
      const { dir, repo, env } = scratch('waiting');
      const dataDir = tempDataDir();
      const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
      const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, design === 'simplified' ? { design } : {});
      try {
        await window.setViewportSize(VIEWPORT);
        await window.emulateMedia({ colorScheme: theme });
        await pinFonts(window);
        await pickFolderNext(app, repo);
        await browseForZone(window);
        await pinRandomText(window);

        await zoneControl(window, 'monorepo', 'New agent', 'New agent');
        const sheet = window.getByRole('dialog', { name: 'New agent' });
        await sheet.getByRole('group', { name: 'Start' }).getByRole('button', { name: 'Crew' }).click();
        await expect(sheet.getByRole('button', { name: /Implementer \+ reviewer/ })).toBeVisible();
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(sheet).toHaveScreenshot(`${named('crew-sheet')}.png`, SHOT);
        await restorePointer();
        await sheet.getByRole('button', { name: 'Cancel' }).click();

        await window.locator('.react-flow__pane').click({ button: 'right', position: { x: 20, y: 200 } });
        await window.getByRole('menuitem', { name: 'New crew' }).press('ArrowRight');
        await expect(window.getByRole('menuitem', { name: 'Library…' })).toBeVisible();
        await settle(window);
        await expect.soft(window.locator('body')).toHaveScreenshot(`${named('crew-right-click')}.png`, SHOT);
        await window.keyboard.press('Escape');
        await window.keyboard.press('Escape');

        // A crew of more than three, for its +N.
        await saveBigCrew(window);
        await window.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
        const spotlight = window.getByRole('dialog', { name: 'Jump to a session or zone' });
        await spotlight.getByRole('combobox', { name: 'Jump to a session or zone' }).fill('crew');
        await expect(spotlight.getByTestId('spotlight-row').filter({ hasText: 'Crew library' })).toBeVisible();
        await expect(spotlight.getByTestId('spotlight-row').filter({ hasText: 'Five crew checks' })).toBeVisible();
        await settle(window);
        await expect.soft(spotlight).toHaveScreenshot(`${named('crew-spotlight')}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
