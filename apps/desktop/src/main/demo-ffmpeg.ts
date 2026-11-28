// Which ffmpeg a demo recording runs, and which of its encoders. Only the recording specs use it, so it never reaches a
// build.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DEMO_ENCODERS, type DemoEncoder } from './demo-capture';

/** The encoders a recording tries when none is asked for, best first: ProRes on the media engine, then in software, then H.264. */
const ENCODER_PREFERENCE: readonly DemoEncoder[] = ['prores', 'prores-sw', 'h264', 'x264'];

/**
 * The `binary` an npm package ships, found from the project at `projectDir` through `chain`: the project's dependency
 * first, then that one's, and so on, as a package manager that hoists nothing lays them out. Undefined when any link
 * isn't installed, or the last package has no such binary.
 */
export function packagedBinary(projectDir: string, chain: readonly string[], binary: string): string | undefined {
  try {
    let from = join(projectDir, 'package.json');
    for (const name of chain) from = createRequire(from).resolve(`${name}/package.json`);
    const path = join(dirname(from), binary);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Whether ffmpeg's `-encoders` list `listing` has `encoder`'s codec. */
const has = (listing: string, encoder: DemoEncoder) => new RegExp(`\\s${DEMO_ENCODERS[encoder][1]}\\s`).test(listing);

/**
 * The encoder to record with, from ffmpeg's `-encoders` list: `requested` if it has it, else (with none requested) the
 * best of `ENCODER_PREFERENCE` it has. Otherwise why not, for the failure to say.
 */
export function pickEncoder(listing: string, requested?: DemoEncoder): { encoder: DemoEncoder } | { why: string } {
  if (requested !== undefined) return has(listing, requested) ? { encoder: requested } : { why: `it has no ${DEMO_ENCODERS[requested][1]} encoder` };
  const encoder = ENCODER_PREFERENCE.find((each) => has(listing, each));
  return encoder === undefined ? { why: `it has none of ${ENCODER_PREFERENCE.map((each) => DEMO_ENCODERS[each][1]).join(', ')}` } : { encoder };
}
