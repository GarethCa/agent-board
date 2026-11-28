import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegEnv } from './demo-capture';
import { packagedBinary, pickEncoder } from './demo-ffmpeg';

const dir = mkdtempSync(join(tmpdir(), 'demo-ffmpeg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Writes `files` (path to contents) under `root`. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

const pkg = (name: string) => JSON.stringify({ name, version: '1.0.0' });

/** A project laid out as pnpm installs it: each package beside its own dependencies, none hoisted but the first. */
function project(name: string, { binary = true } = {}): string {
  const root = join(dir, name);
  const store = 'node_modules/.pnpm';
  tree(root, {
    'package.json': pkg('project'),
    'node_modules/@acme/cli/package.json': pkg('@acme/cli'),
    [`${store}/cli/node_modules/@acme/renderer/package.json`]: pkg('@acme/renderer'),
    [`${store}/renderer/node_modules/@acme/tools-darwin-arm64/package.json`]: pkg('@acme/tools-darwin-arm64'),
    ...(binary ? { [`${store}/renderer/node_modules/@acme/tools-darwin-arm64/ffmpeg`]: '' } : {}),
  });
  // pnpm's links: the CLI's renderer beside it, and the renderer's tools beside that.
  const link = (from: string, to: string) => {
    mkdirSync(join(root, from, '..'), { recursive: true });
    symlinkSync(join(root, to), join(root, from));
  };
  link('node_modules/@acme/cli/node_modules/@acme/renderer', `${store}/cli/node_modules/@acme/renderer`);
  link(`${store}/cli/node_modules/@acme/renderer/node_modules/@acme/tools-darwin-arm64`, `${store}/renderer/node_modules/@acme/tools-darwin-arm64`);
  return root;
}

const CHAIN = ['@acme/cli', '@acme/renderer', '@acme/tools-darwin-arm64'];

describe('packagedBinary', () => {
  it('finds the binary in the last package of the chain, through each dependency in turn', () => {
    expect(packagedBinary(project('installed'), CHAIN, 'ffmpeg')).toMatch(/@acme\/tools-darwin-arm64\/ffmpeg$/);
  });

  it('finds nothing for a package not installed, a binary missing, or a project not installed at all', () => {
    expect(packagedBinary(project('other'), ['@acme/cli', '@acme/renderer', '@acme/tools-darwin-x64'], 'ffmpeg')).toBeUndefined();
    expect(packagedBinary(project('no-binary', { binary: false }), CHAIN, 'ffmpeg')).toBeUndefined();
    tree(join(dir, 'bare'), { 'package.json': pkg('project') });
    expect(packagedBinary(join(dir, 'bare'), CHAIN, 'ffmpeg')).toBeUndefined();
  });
});

describe('ffmpegEnv', () => {
  it("puts the binary's own folder first on the library path when its libav libraries sit beside it", () => {
    tree(join(dir, 'bundled'), { ffmpeg: '', 'libavcodec.dylib': '' });
    expect(ffmpegEnv(join(dir, 'bundled', 'ffmpeg'), { PATH: '/bin' })).toEqual({ PATH: '/bin', DYLD_LIBRARY_PATH: join(dir, 'bundled') });
    expect(ffmpegEnv(join(dir, 'bundled', 'ffmpeg'), { DYLD_LIBRARY_PATH: '/opt/lib' }).DYLD_LIBRARY_PATH).toBe(`${join(dir, 'bundled')}:/opt/lib`);
  });

  it('leaves the environment alone for ffmpeg on the PATH, or one without libraries beside it', () => {
    const env = { PATH: '/bin' };
    expect(ffmpegEnv('ffmpeg', env)).toBe(env);
    tree(join(dir, 'brew'), { ffmpeg: '' });
    expect(ffmpegEnv(join(dir, 'brew', 'ffmpeg'), env)).toBe(env);
  });
});

/** An `ffmpeg -encoders` listing with `codecs`. */
const listing = (...codecs: string[]) => ['Encoders:', ' ------', ...codecs.map((codec) => ` V....D ${codec}  (codec x)`)].join('\n');

describe('pickEncoder', () => {
  it('takes hardware ProRes when ffmpeg has it', () => {
    expect(pickEncoder(listing('libx264', 'prores_ks', 'prores_videotoolbox'))).toEqual({ encoder: 'prores' });
  });

  it('falls back to software ProRes, then hardware H.264, then x264', () => {
    expect(pickEncoder(listing('libx264', 'prores_ks', 'h264_videotoolbox'))).toEqual({ encoder: 'prores-sw' });
    expect(pickEncoder(listing('libx264', 'h264_videotoolbox'))).toEqual({ encoder: 'h264' });
    expect(pickEncoder(listing('libx264'))).toEqual({ encoder: 'x264' });
  });

  it('says what it looked for when ffmpeg has none of them', () => {
    expect(pickEncoder(listing('png'))).toEqual({ why: 'it has none of prores_videotoolbox, prores_ks, h264_videotoolbox, libx264' });
  });

  it('keeps to the encoder asked for, and says so when ffmpeg lacks it', () => {
    expect(pickEncoder(listing('prores_videotoolbox', 'libx264'), 'x264')).toEqual({ encoder: 'x264' });
    expect(pickEncoder(listing('libx264'), 'prores')).toEqual({ why: 'it has no prores_videotoolbox encoder' });
  });

  it("doesn't take a codec whose name only starts another's", () => {
    expect(pickEncoder(listing('prores_videotoolbox_x'))).toEqual({ why: expect.stringContaining('none of') });
  });
});
