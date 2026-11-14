import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import { LEFT_SCREEN_EXIT_MS, watchLeftScreen } from '../src/left-screen.ts';

const SIZE = { cols: 40, rows: 6 };

/** A headless terminal watched for the screen it leaves, on a clock the test moves. */
function watched() {
  const model = new xtermHeadless.Terminal({ ...SIZE, scrollback: 100, allowProposedApi: true });
  const serializer = new xtermSerialize.SerializeAddon();
  model.loadAddon(serializer);
  const clock = { now: 1_000 };
  const left = watchLeftScreen(model, serializer, 100, () => clock.now);
  const write = (data: string) => new Promise<void>((resolve) => model.write(data, resolve));
  return { left, write, clock };
}

/** The lines a fresh terminal of the same size shows, scrollback included, once `data` is written to it. */
async function shown(data: string): Promise<string[]> {
  const terminal = new xtermHeadless.Terminal({ ...SIZE, scrollback: 100, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)!.translateToString(true));
  return lines.filter((line) => line !== '');
}

const FULLSCREEN = '\x1b[?1049h\x1b[H╭ Claude ╮\r\n> Run the tests\r\nAll tests pass.';
const LEAVE = '\x1b[?1049l';
const EXIT = `${LEAVE}\r\nResume this session with:\r\nclaude --resume 1234`;

describe('the screen a full-screen program leaves', () => {
  it('is kept as it leaves, under the normal screen it went back to, as plain lines a fresh terminal shows', async () => {
    const { left, write } = watched();
    await write(`claude is starting\r\n${FULLSCREEN}${EXIT}`);

    const screen = left.last();

    expect(screen).toMatchObject(SIZE);
    expect(screen!.data).not.toContain('\x1b[?1049h');
    expect(await shown(screen!.data)).toEqual([
      'claude is starting',
      '╭ Claude ╮',
      '> Run the tests',
      'All tests pass.',
      'Resume this session with:',
      'claude --resume 1234',
    ]);
  });

  it('keeps what it wrote on the normal screen after leaving, as the error it died of, under the screen it left', async () => {
    const { left, write } = watched();
    await write(`claude is starting\r\n${FULLSCREEN}${LEAVE}\x1b[31mError: ENOSPC\x1b[0m\r\n`);

    expect(await shown(left.last()!.data)).toEqual(['claude is starting', '╭ Claude ╮', '> Run the tests', 'All tests pass.', 'Error: ENOSPC']);
  });

  it('lays the screen it left under all of the normal screen, wherever the cursor was on it', async () => {
    const { left, write } = watched();
    await write(`n1\r\nn2\r\nn3\x1b[H\x1b[?1049h\x1b[Hb1\r\nb2${LEAVE}`);

    expect(await shown(left.last()!.data)).toEqual(['n1', 'n2', 'n3', 'b1', 'b2']);
  });

  it('lays what it wrote after under the screen it left, wherever that screen left the cursor', async () => {
    const { left, write } = watched();
    await write(`\x1b[?1049h\x1b[Hb1\r\nb2\r\nb3\x1b[1;1H${LEAVE}after`);

    expect(await shown(left.last()!.data)).toEqual(['b1', 'b2', 'b3', 'after']);
  });

  it('starts at the top when the normal screen held nothing', async () => {
    const { left, write } = watched();
    await write(`${FULLSCREEN}${EXIT}`);

    expect((await shown(left.last()!.data))[0]).toBe('╭ Claude ╮');
  });

  it('is nothing for a program that never left the alternate screen, or went back to it, or left it long before', async () => {
    const { left, write, clock } = watched();
    await write('plain output\r\n');
    expect(left.last()).toBeUndefined();

    await write(`${FULLSCREEN}${EXIT}\x1b[?1049h`);
    expect(left.last()).toBeUndefined();

    await write(EXIT);
    clock.now += LEFT_SCREEN_EXIT_MS;
    expect(left.last()).toBeDefined();
    clock.now += 1;
    expect(left.last()).toBeUndefined();
  });

  it('counts only a switch of screens, not the other private modes', async () => {
    const { left, write } = watched();
    await write(`${FULLSCREEN}\x1b[?25l\x1b[?2004l`);

    expect(left.last()).toBeUndefined();
  });
});
