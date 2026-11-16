/**
 * One terminal with several clients attached, as when the app has two windows on it: each sees its output, the size
 * its latest user asked for is the terminal's for all of them, and a client attaching late is given the screen at that
 * size.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '../../src/client.ts';
import type { DaemonEvent, SessionSnapshotEvent } from '../../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon } from '../helpers.ts';

async function viewers(count: number) {
  const daemon = await startTestDaemon();
  const clients: DaemonClient[] = [];
  for (let i = 0; i < count; i += 1) clients.push(await connectTestClient(daemon));
  const recorders = clients.map(recordEvents);
  const session = await clients[0]!.call('session.createShell', { cols: 80, rows: 24 });
  for (const client of clients) await client.call('session.attach', { sessionId: session.id });
  return { daemon, clients, recorders, session };
}

describe('a terminal with several viewers', () => {
  it('shows its output to each of them', async () => {
    const { clients, recorders, session } = await viewers(3);
    await clients[1]!.call('session.write', { sessionId: session.id, data: 'echo seen-$((40 + 2))\r' });
    for (const recorder of recorders) await recorder.waitForText(session.id, 'seen-42');
  });

  it('takes the size its latest user asked for, typing or resizing, and its program sees that size', async () => {
    const { daemon, clients, recorders, session } = await viewers(2);
    const sizeNow = async () => (await clients[0]!.call('session.list')).find((one) => one.id === session.id);
    await clients[1]!.call('session.resize', { sessionId: session.id, cols: 100, rows: 30 });
    await clients[0]!.call('session.resize', { sessionId: session.id, cols: 90, rows: 20 });
    expect(await sizeNow()).toMatchObject({ cols: 90, rows: 20 });

    // Typing makes a viewer the latest user: the terminal takes its size before its keys reach the program.
    await clients[1]!.call('session.write', { sessionId: session.id, data: 'echo size-$(stty size | tr " " x)\r' });
    for (const recorder of recorders) await recorder.waitForText(session.id, 'size-30x100');
    expect(await sizeNow()).toMatchObject({ cols: 100, rows: 30 });

    // A viewer attaching now is drawn the screen at that size.
    const late = await connectTestClient(daemon);
    const lateEvents = recordEvents(late);
    await late.call('session.attach', { sessionId: session.id });
    const snapshot = await lateEvents.waitFor((event: DaemonEvent): event is SessionSnapshotEvent => event.type === 'session.snapshot' && event.sessionId === session.id);
    expect(snapshot).toMatchObject({ cols: 100, rows: 30, data: expect.stringContaining('size-30x100') });

    // When the latest user goes, the one before it takes the terminal back at the size it last asked for.
    clients[1]!.close();
    await vi.waitFor(async () => expect(await sizeNow()).toMatchObject({ cols: 90, rows: 20 }));
  });

  it('keeps showing it to the others when one viewer detaches or goes', async () => {
    const { clients, recorders, session } = await viewers(3);
    await clients[0]!.call('session.detach', { sessionId: session.id });
    clients[1]!.close();
    await clients[2]!.call('session.write', { sessionId: session.id, data: 'echo still-$((40 + 3))\r' });
    await recorders[2]!.waitForText(session.id, 'still-43');
    expect(recorders[0]!.screenText(session.id)).not.toContain('still-43');
  });
});
