import { expect, type Page } from '@playwright/test';
import { agents } from './agent-helpers.ts';

export const LONG = 'a-very-long-unbroken-name-'.repeat(8);
export const PATH = 'packages/deeply/nested/folder/with/a/long/path/to/some/file.ts:1234';

/** The Captain started, a zone and an agent with names too long to fit, and a digest with a long path, link and code. */
export async function crowdedPanel(window: Page, writtenAt = new Date().toISOString()) {
  await window.getByTestId('master-button').click();
  await window.getByTestId('master-start').click();
  await expect(window.getByTestId('master-badge')).toHaveCount(1);
  await window.evaluate(async (name) => {
    await globalThis.window.agentBoard.zones.addUnbound({ name, x: 900, y: 80, width: 300, height: 200 });
  }, LONG);
  const [master] = (await agents(window)).filter((agent) => agent.master);
  await window.evaluate(
    async ({ sessionId, text, writtenAt }) => {
      await globalThis.window.agentBoard.items.create({
        kind: 'agent-note',
        zoneId: null,
        x: 1000,
        y: 400,
        width: 200,
        height: 150,
        data: { text, agent: { sessionId, name: 'Captain', harness: 'claude', role: 'captain' }, about: sessionId, writtenAt, editedByUser: false },
      });
    },
    { sessionId: master!.sessionId, writtenAt, text: `**Digest**\n\n${PATH}\n\nhttps://example.com/${'segment/'.repeat(20)}\n\n\`${'code_span_'.repeat(12)}\`\n\n\`\`\`\n${PATH} ${PATH}\n\`\`\`` },
  );
}

