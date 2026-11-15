import { test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * A record of what a page's menus and focus do, kept to read when a step on a menu fails: the page logs each focus
 * move, each menu shown or taken away, each `aria-expanded` change, each dismissal Radix sends, and each button the
 * DOM replaces, with the time since the trail started. `read` adds the page as it stands then.
 */
export interface MenuTrail {
  /** What the page logged, the page's console, and the page as it stands now: the menus, their items and focus. */
  read(): Promise<string>;
  /** Runs `step`; if it throws, attaches the trail (and a screenshot) to the test, then throws again. */
  around<T>(name: string, step: () => Promise<T>): Promise<T>;
}

export async function startMenuTrail(window: Page): Promise<MenuTrail> {
  const consoleLines: string[] = [];
  const started = Date.now();
  window.on('console', (message) => consoleLines.push(`${Date.now() - started}ms ${message.type()}: ${message.text()}`));
  window.on('pageerror', (error) => consoleLines.push(`${Date.now() - started}ms pageerror: ${error.message}`));
  await window.evaluate(() => {
    const t0 = performance.now();
    const lines: string[] = [];
    (globalThis as { __menuTrail?: string[] }).__menuTrail = lines;
    const describe = (node: EventTarget | Node | null): string => {
      if (!(node instanceof Element)) return node === document ? 'document' : String(node);
      const role = node.getAttribute('role');
      const label = node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 40) ?? '';
      const inDialog = node.closest('[role="dialog"]') ? ' [in dialog]' : '';
      const inMenu = node.closest('[role="menu"]') ? ' [in menu]' : '';
      return `<${node.tagName.toLowerCase()}${role ? ` role=${role}` : ''}> "${label}"${inDialog}${inMenu}`;
    };
    const log = (line: string) => lines.push(`${Math.round(performance.now() - t0)}ms ${line}`);
    for (const type of ['focusin', 'focusout', 'pointerdown', 'pointerup', 'click']) {
      document.addEventListener(type, (event) => log(`${type} ${describe(event.target)}${event instanceof FocusEvent ? ` related=${describe(event.relatedTarget)}` : ''}`), true);
    }
    // Radix's dismissal events don't bubble; a listener in the capture phase still hears them.
    for (const type of ['dismissableLayer.focusOutside', 'dismissableLayer.pointerDownOutside', 'focusScope.autoFocusOnMount', 'focusScope.autoFocusOnUnmount']) {
      document.addEventListener(type, (event) => log(`${type} on ${describe(event.target)}${event.defaultPrevented ? ' (prevented)' : ''}`), true);
    }
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          log(`${record.attributeName}=${(record.target as Element).getAttribute(record.attributeName!)} on ${describe(record.target)}`);
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          for (const found of [node, ...node.querySelectorAll('[role="menu"], button[aria-haspopup="menu"]')]) {
            if (found.matches('[role="menu"], button[aria-haspopup="menu"]')) log(`added ${describe(found)}`);
          }
        }
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          for (const found of [node, ...node.querySelectorAll('[role="menu"], button[aria-haspopup="menu"]')]) {
            if (found.matches('[role="menu"], button[aria-haspopup="menu"]')) log(`removed ${describe(found)}`);
          }
        }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded', 'data-state'] });
    log('trail started');
  });

  const read = async (): Promise<string> => {
    const page = await window
      .evaluate(() => {
        const describe = (node: Element | null) => (node ? `<${node.tagName.toLowerCase()}${node.getAttribute('role') ? ` role=${node.getAttribute('role')}` : ''}> "${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 40) ?? ''}"` : 'none');
        const buttons = [...document.querySelectorAll('button[aria-haspopup="menu"]')].map((button) => `${describe(button)} aria-expanded=${button.getAttribute('aria-expanded')} data-state=${button.getAttribute('data-state')}`);
        const menus = [...document.querySelectorAll('[role="menu"]')].map((menu) => `${describe(menu)} data-state=${menu.getAttribute('data-state')}\n    items: ${[...menu.querySelectorAll('[role^="menuitem"]')].map((item) => JSON.stringify(item.textContent?.trim())).join(', ')}`);
        return [
          `activeElement: ${describe(document.activeElement)}`,
          `menu buttons:\n  ${buttons.join('\n  ') || 'none'}`,
          `menus:\n  ${menus.join('\n  ') || 'none'}`,
          `trail:\n  ${((globalThis as { __menuTrail?: string[] }).__menuTrail ?? []).join('\n  ')}`,
        ].join('\n');
      })
      .catch((error: unknown) => `page could not be read: ${String(error)}`);
    return `${page}\nconsole:\n  ${consoleLines.join('\n  ') || 'none'}`;
  };

  return {
    read,
    async around(name, step) {
      try {
        return await step();
      } catch (error) {
        // Written to the test's output folder, which a failed run keeps whatever the reporter.
        const info = test.info();
        const trailPath = info.outputPath('menu-trail.txt');
        writeFileSync(trailPath, await read());
        await info.attach(`${name}: menu trail`, { path: trailPath, contentType: 'text/plain' });
        const shotPath = info.outputPath('menu-trail.png');
        if (await window.screenshot({ path: shotPath }).then(() => true, () => false)) await info.attach(`${name}: screenshot`, { path: shotPath, contentType: 'image/png' });
        throw error;
      }
    },
  };
}
