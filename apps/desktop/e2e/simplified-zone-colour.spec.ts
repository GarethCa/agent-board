import { expect } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { test, tempDataDir, removeDataDir } from './launch.ts';

// A project under the Simplified design keeps its colour: its well and edge are tinted from the zone's colour, and
// change with it and with its fill opacity.

for (const appearance of ['light', 'dark'] as const) {
test(`a project well under the Simplified design takes its colour from the zone, and changes with it, ${appearance}`, async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { AGENT_BOARD_APPEARANCE: appearance }, [], { design: 'simplified' });
  try {
    const zone = await window.evaluate(async () => {
      const created = await globalThis.window.agentBoard.zones.addUnbound({ name: 'Billing', x: 0, y: 0, width: 520, height: 300 });
      await globalThis.window.agentBoard.zones.setLook(created.id, { color: '#4c6ef5', fillOpacity: null });
      return created.id;
    });
    const well = window.locator('.zone.project-well').first();
    const read = () => well.evaluate((el) => ({ fill: getComputedStyle(el).backgroundColor, edge: getComputedStyle(el).borderTopColor }));
    // A group (this zone has no repo) draws a solid edge: dashed is the drop cue.
    await expect(well).toHaveCSS('border-top-style', 'solid');
    await expect(well).toBeVisible();
    await expect.poll(async () => (await read()).fill).not.toBe('rgba(0, 0, 0, 0)');
    const blue = await read();
    await window.evaluate((id) => globalThis.window.agentBoard.zones.setLook(id, { color: '#2f9e44', fillOpacity: null }), zone);
    await expect.poll(async () => (await read()).fill).not.toBe(blue.fill);
    await expect.poll(async () => (await read()).edge).not.toBe(blue.edge);
    // A fill of its own strengthens the well.
    const green = await read();
    await window.evaluate((id) => globalThis.window.agentBoard.zones.setLook(id, { color: '#2f9e44', fillOpacity: 30 }), zone);
    await expect.poll(async () => (await read()).fill).not.toBe(green.fill);
    await expect.poll(async () => (await read()).edge).not.toBe(green.edge);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
}
