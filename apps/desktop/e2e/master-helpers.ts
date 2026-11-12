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

type Box = { x: number; y: number; width: number; height: number };

/** Whether any two of the boxes share area. */
export const intersecting = (boxes: Record<string, Box | null>) => {
  const named = Object.entries(boxes).filter((entry): entry is [string, Box] => entry[1] !== null);
  return named.flatMap(([a, p], i) =>
    named.slice(i + 1).flatMap(([b, q]) => (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height ? [`${a} / ${b}`] : [])),
  );
};

/** The top row's islands: the board menu, the creation toolbar and the top-right island, and the pane if it is open. */
async function topRowOf(window: Page): Promise<Record<string, Box | null>> {
  const box = async (selector: string) => ((await window.locator(selector).count()) === 0 ? null : window.locator(selector).first().boundingBox());
  return { menu: await box('.island-top-left'), toolbar: await box('.create-toolbar'), right: await box('.island-top-right'), pane: await box('[data-testid="master-panel"]') };
}

/** Which of the top row's islands meet, each with every box, so a failure shows where they were; none when it fits. */
export async function topRowMeets(window: Page): Promise<string[]> {
  const row = await topRowOf(window);
  return intersecting(row).map((pair) => `${pair}: ${JSON.stringify(row)}`);
}

