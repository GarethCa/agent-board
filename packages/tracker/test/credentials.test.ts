import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createKeychainStore, KEYCHAIN_SERVICE } from '../src/index.ts';
import { createTempKeychain } from '../src/testing.ts';

describe.runIf(process.platform === 'darwin')('the macOS keychain store', () => {
  let keychain: ReturnType<typeof createTempKeychain>;
  beforeAll(() => {
    keychain = createTempKeychain();
  });
  afterAll(() => keychain.remove());

  it('stores, replaces, reads and deletes a secret', async () => {
    const store = createKeychainStore({ keychain: keychain.path });
    expect(await store.get('linear')).toBeUndefined();

    await store.set('linear', 'lin_api_first');
    await store.set('linear', 'lin_api_second');
    expect(await store.get('linear')).toBe('lin_api_second');
    // A real keychain item, under agent-board's service.
    const item = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'linear', keychain.path],
      {
        encoding: 'utf8',
      },
    );
    expect(item).toContain('"svce"<blob>="agent-board"');

    await store.delete('linear');
    expect(await store.get('linear')).toBeUndefined();
    await store.delete('linear');
  });

  it('keeps accounts apart', async () => {
    const store = createKeychainStore({ keychain: keychain.path });
    await store.set('linear', 'lin_api_one');
    await store.set('github', 'gho_two');
    expect(await store.get('linear')).toBe('lin_api_one');
    expect(await store.get('github')).toBe('gho_two');
  });

  it('refuses a keychain file that does not exist, rather than using the login keychain', async () => {
    const missing = createKeychainStore({ keychain: `${keychain.path}.missing` });
    await expect(missing.get('linear')).rejects.toThrow('no keychain at');
    await expect(missing.set('linear', 'lin_api_x')).rejects.toThrow('no keychain at');
    await expect(missing.delete('linear')).rejects.toThrow('no keychain at');
  });

  it('refuses secrets it could not pass to the keychain safely', async () => {
    const store = createKeychainStore({ keychain: keychain.path });
    for (const secret of ['', 'two words', 'a"quote', 'new\nline']) {
      await expect(store.set('linear', secret)).rejects.toThrow('does not look like an API key');
    }
  });

  it('refuses an account name that could end the keychain command and start another', async () => {
    const store = createKeychainStore({ keychain: keychain.path });
    await store.set('linear', 'lin_api_kept');
    // Closes the quoted account and ends the line, so its first command overwrites `linear`. Every line it makes names
    // the temporary keychain, so even unchecked it can't reach the login keychain; what's left over runs `help`.
    const injected = `linear" -w "lin_api_evil" "${keychain.path}"\nhelp "x`;
    await store.set(injected, 'lin_api_x').catch(() => {});
    expect(await store.get('linear')).toBe('lin_api_kept');

    const refused = [injected, '', '-x', '--help', 'two words', 'a"quote', 'new\nline', 'back\\slash', 'x'.repeat(129)];
    for (const account of refused) {
      await expect(store.set(account, 'lin_api_x')).rejects.toThrow('not a valid account name');
    }
    await store.delete('linear');
  });

  it('accepts account names like a provider or a provider and a host', async () => {
    const store = createKeychainStore({ keychain: keychain.path });
    for (const account of ['github', 'github.enterprise.example', 'linear-work_2', 'test-account']) {
      await store.set(account, 'tok_ok');
      expect(await store.get(account)).toBe('tok_ok');
      await store.delete(account);
    }
  });

  it('stores a long token whose command still fits on one line of the keychain tool', async () => {
    const store = createKeychainStore({ keychain: keychain.path });
    const long = 'a'.repeat(3700);
    await store.set('linear', long);
    expect(await store.get('linear')).toBe(long);
    await store.delete('linear');
  });

  // The keychain tool cuts lines at 4095 characters and runs the first piece without the keychain file, so with the
  // check gone this would write to the login keychain. With no tools on the PATH, that regression fails as
  // "security was not found" instead.
  it('refuses a secret too long for one line of the keychain tool, before running it', async () => {
    const store = createKeychainStore({ keychain: keychain.path });
    const path = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), 'no-tools-'));
    try {
      await expect(store.set('linear', 'a'.repeat(4000))).rejects.toThrow('too long to store');
      await expect(store.set('x'.repeat(128), 'a'.repeat(3850))).rejects.toThrow('too long to store');
    } finally {
      process.env.PATH = path;
    }
  });

  it('refuses a keychain path that could end the keychain command', async () => {
    for (const path of [`${keychain.path}"`, `${keychain.path}\nx`, `${keychain.path}\\`]) {
      const store = createKeychainStore({ keychain: path });
      await expect(store.set('linear', 'lin_api_x')).rejects.toThrow('not a safe keychain path');
    }
  });
});

it('says storing is unsupported where it has no keychain', async () => {
  const store = createKeychainStore({ platform: 'win32' });
  expect(await store.get('linear')).toBeUndefined();
  await expect(store.set('linear', 'lin_api_x')).rejects.toThrow('not supported on win32');
});

it('never reaches the Secret Service when given a keychain file, which only macOS has', async () => {
  // With no secret-tool on the PATH, any call to it would fail with "secret-tool was not found".
  const path = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'no-tools-'));
  try {
    const store = createKeychainStore({ platform: 'linux', keychain: '/tmp/test.keychain-db' });
    expect(await store.get('linear')).toBeUndefined();
    await expect(store.set('linear', 'lin_api_x')).rejects.toThrow('keychain files are macOS-only');
    await expect(store.delete('linear')).resolves.toBeUndefined();
  } finally {
    process.env.PATH = path;
  }
});

it('checks account names on the Secret Service too, without running its tool', async () => {
  // With no secret-tool on the PATH, any call to it would fail with "secret-tool was not found".
  const path = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'no-tools-'));
  try {
    const store = createKeychainStore({ platform: 'linux' });
    await expect(store.set('a"b', 'lin_api_x')).rejects.toThrow('not a valid account name');
    await expect(store.set('--help', 'lin_api_x')).rejects.toThrow('not a valid account name');
    expect(await store.get('--help')).toBeUndefined();
    await expect(store.delete('--help')).resolves.toBeUndefined();
  } finally {
    process.env.PATH = path;
  }
});

// As for gh: what fails without the fix is Vitest's check for unhandled errors. A secret fits in a pipe buffer, so
// only some writes lose the race with the exiting tool; enough attempts make at least one lose it.
it('settles when the Secret Service tool exits without reading the secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-tool-exits-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'secret-tool'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = dir;
  try {
    const store = createKeychainStore({ platform: 'linux' });
    for (let attempt = 0; attempt < 50; attempt++) {
      await expect(store.set('linear', 'lin_api_x')).rejects.toThrow('could not write to the Secret Service');
    }
  } finally {
    process.env.PATH = path;
  }
});
