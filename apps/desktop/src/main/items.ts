import { join } from 'node:path';
import { ipcMain, net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import type { DaemonLink } from '@agent-board/daemon/client';
import { IMAGE_EXTENSIONS, type CreateItemParams, type UpdateItemParams } from '@agent-board/daemon/protocol';
import { ITEM_IPC } from '../preload/api';
import { IMAGE_SCHEME } from '../shared/image-url';
import { forwardEvents } from './broadcast';
import { handImage } from './image-staging';

/** The board item IPC the preload's `items` API calls. Every window hears every change, so boards stay in step. */
export function registerItemIpc(daemon: DaemonLink, dataDir: string): void {
  forwardEvents(daemon, ['item.updated', 'item.removed'], ITEM_IPC.changed);

  ipcMain.handle(ITEM_IPC.list, () => daemon.call('item.list'));
  ipcMain.handle(ITEM_IPC.create, (_event, params: CreateItemParams) => daemon.call('item.create', params));
  ipcMain.handle(ITEM_IPC.update, (_event, params: UpdateItemParams) => daemon.call('item.update', params));
  ipcMain.handle(ITEM_IPC.importImage, (_event, bytes: unknown) => handImage(dataDir, bytes, (path) => daemon.call('image.import', { path })));
  ipcMain.handle(ITEM_IPC.delete, async (_event, id: string) => {
    await daemon.call('item.delete', { id });
  });
}

const IMAGE_FILE = new RegExp(`^[0-9a-f]{64}\\.(${IMAGE_EXTENSIONS.join('|')})$`);

/** `agent-board-image://<sha256>.<ext>` is a scheme the renderer loads images through; this must run before `app` is ready. */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves the image store's files under the image scheme, and nothing else, once `app` is ready. */
export function registerImageProtocol(dataDir: string): void {
  protocol.handle(IMAGE_SCHEME, (request) => {
    const name = new URL(request.url).hostname;
    if (!IMAGE_FILE.test(name)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(join(dataDir, 'images', name)).href);
  });
}
