// What a terminal's snapshot costs: the daemon serializing a session's scrollback as it does on every attachment, and
// a terminal parsing it, with nothing drawn. Run by hand (`pnpm --filter @agent-board/daemon bench:snapshot`), never by a
// gate. The lines are the rendering benchmark's (apps/desktop/e2e/render-bench.spec.ts).
//
// `node scripts/snapshot-cost.ts [cols] [lines…]`: 80 columns by default, the size a shell starts at, where each of the
// benchmark's lines wraps to two rows; and 1000 3000 5000 8000 lines. Each figure is the median of five runs.
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import { SCROLLBACK_LINES } from '../src/protocol.ts';

const [colsArg, ...linesArgs] = process.argv.slice(2);
const cols = Number(colsArg ?? 80);
const lineCounts = linesArgs.length > 0 ? linesArgs.map(Number) : [1000, 3000, 5000, 8000];
const RUNS = 5;

const terminal = () => new xtermHeadless.Terminal({ cols, rows: 28, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
const write = (into: xtermHeadless.Terminal, data: string) => new Promise<void>((resolve) => into.write(data, resolve));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** The benchmark's lines: coloured, numbered, about 85 columns of text. */
function transcript(lines: number): string {
  let out = '';
  for (let i = 0; i < lines; i++) {
    out += `\x1b[3${(i % 7) + 1}m${String(i).padStart(6, '0')}\x1b[0m \x1b[1mtool\x1b[0m Read src/session/store-${i % 97}.ts: the quick brown fox jumps over the lazy dog\r\n`;
  }
  return out;
}

for (const lines of lineCounts) {
  const model = terminal();
  const serializer = new xtermSerialize.SerializeAddon();
  model.loadAddon(serializer);
  await write(model, transcript(lines));
  const serializeMs: number[] = [];
  const parseMs: number[] = [];
  let snapshot = '';
  for (let run = 0; run < RUNS; run++) {
    let start = performance.now();
    snapshot = serializer.serialize({ scrollback: SCROLLBACK_LINES });
    serializeMs.push(performance.now() - start);
    const view = terminal();
    start = performance.now();
    await write(view, snapshot);
    parseMs.push(performance.now() - start);
    view.dispose();
  }
  const rows = model.buffer.active.length;
  console.log(
    JSON.stringify({ cols, lines, rows, snapshotKb: Math.round(snapshot.length / 1024), serializeMs: Number(median(serializeMs).toFixed(1)), parseMs: Number(median(parseMs).toFixed(1)) }),
  );
  model.dispose();
}
