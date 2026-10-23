import { join } from 'node:path';
import { ipcMain, net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import type { DaemonLink } from '@agent-board/daemon/client';
import { IMAGE_EXTENSIONS, type ClockData, type ClockPlace, type CreateItemParams, type UpdateItemParams } from '@agent-board/daemon/protocol';
import { ITEM_IPC } from '../preload/api';
import { IMAGE_SCHEME } from '../shared/image-url';
import { forwardEvents } from './broadcast';
import { handImage } from './image-staging';
import { passthrough, passthroughVoid } from './passthrough';

/** The board item IPC the preload's `items` API calls. Every window hears every change, so boards stay in step. */
export function registerItemIpc(daemon: DaemonLink, dataDir: string): void {
  forwardEvents(daemon, ['item.updated', 'item.removed'], ITEM_IPC.changed);
  forwardEvents(daemon, ['clock.updated'], ITEM_IPC.clockChanged);

  passthrough(daemon, ITEM_IPC.list, 'item.list');
  passthrough(daemon, ITEM_IPC.create, 'item.create', (params: CreateItemParams) => params);
  passthrough(daemon, ITEM_IPC.update, 'item.update', (params: UpdateItemParams) => params);
  ipcMain.handle(ITEM_IPC.importImage, (_event, bytes: unknown) => handImage(dataDir, bytes, (path) => daemon.call('image.import', { path })));
  passthroughVoid(daemon, ITEM_IPC.delete, 'item.delete', (id: string) => ({ id }));
  passthrough(daemon, ITEM_IPC.clocks, 'clock.list');
  passthrough(daemon, ITEM_IPC.addClock, 'clock.add', (data: Partial<ClockData>, place: ClockPlace) => ({ data, place }));
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
