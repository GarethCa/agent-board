import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialStore } from '@agent-board/tracker';

/** An account the store keeps a file for: a letter or digit first, then no path separator, as keychain accounts. */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

/** Secrets as files only the user can read, one per account, in `dir` (which only the user can open). */
function createFileCredentialStore(dir: string): CredentialStore {
  const path = (account: string) => {
    if (!ACCOUNT.test(account)) throw new Error('that is not a valid account name');
    return join(dir, account);
  };
  return {
    async get(account) {
      try {
        return await readFile(path(account), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async set(account, secret) {
      const file = path(account);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      // Whole or not at all, and never readable by anyone else, even for a moment.
      const partial = `${file}.${randomUUID()}.partial`;
      try {
        await writeFile(partial, secret, { mode: 0o600, flag: 'wx' });
        await rename(partial, file);
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
    },
    async delete(account) {
      const file = path(account);
      await rm(file, { force: true });
      // And any copy a write cut short (the daemon gone between the write and the rename) left beside it.
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const partial = new RegExp(`^${account.replace(/[.+]/g, '\\$&')}\\.[0-9a-f-]{36}\\.partial$`);
      await Promise.all(names.filter((name) => partial.test(name)).map((name) => rm(join(dir, name), { force: true })));
    },
  };
}

export interface LaunchSettingsStoreOptions {
  /** The OS keychain. */
  keychain: CredentialStore;
  /** Whether this system has a keychain (`keychainAvailability`). */
  availability: 'yes' | 'not-running' | 'no';
  /** Where the values go where there is no keychain: a folder in the data dir, never the database. */
  dir: string;
}

/**
 * Where agents' launch-settings values are kept: the OS keychain where this system has one; otherwise a file per
 * agent only the user can read, in the data dir, as a host with no keychain keeps its server key. A value a file kept
 * before there was a keychain is read from there while the keychain has none, and moves to it at its next write.
 */
export function createLaunchSettingsStore({ keychain, availability, dir }: LaunchSettingsStoreOptions): CredentialStore {
  const files = createFileCredentialStore(dir);
  if (availability === 'no') return files;
  if (availability === 'not-running') {
    return {
      ...files,
      async get(account) {
        const found = await files.get(account);
        if (found !== undefined) return found;
        // Not one a file kept: the keychain this host can't reach now may have it.
        throw new Error("the keychain can't be reached here (no Secret Service is running)");
      },
    };
  }
  return {
    // The keychain first: a file is only ever older than what the keychain holds.
    get: async (account) => (await keychain.get(account)) ?? files.get(account),
    async set(account, secret) {
      await keychain.set(account, secret);
      // A file left behind would hold old values on disk: a write that can't remove it fails.
      await files.delete(account);
    },
    async delete(account) {
      await files.delete(account);
      await keychain.delete(account);
    },
  };
}
