import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LOCAL_SIGNING_NAME, parseLocalIdentity, type Run, setUpLocalSigning, signApp } from './local-signing.ts';

const HASH_A = '63918C45ED35DB92D9242911F4F0B40C202DFE60';
const HASH_B = 'B6736D1CA0D32B3DBD05F9A108C0F5DA599C77CA';
const OTHER = 'AFA7A01B7655604811D0CF5F67BF380B6D95FC52';

/** `security find-identity -p codesigning` as it prints, with `matching` in the first list. */
function findIdentityOutput(matching: string[]): string {
  const rows = matching.map((row, i) => `  ${i + 1}) ${row}`).join('\n');
  return `\nPolicy: Code Signing\n  Matching identities\n${rows}\n     ${matching.length} identities found\n\n  Valid identities only\n  1) ${OTHER} "Apple Development: Someone (TEAM)"\n     1 valid identities found\n`;
}

const ours = (hash: string, status = 'CSSMERR_TP_NOT_TRUSTED') => `${hash} "${LOCAL_SIGNING_NAME}" (${status})`;

describe('parseLocalIdentity', () => {
  it('finds the one local identity, though it is not trusted', () => {
    expect(parseLocalIdentity(findIdentityOutput([`${OTHER} "Apple Development: Someone (TEAM)"`, ours(HASH_A)]))).toEqual({ kind: 'one', hash: HASH_A });
  });

  it('finds it when trusted, with no status', () => {
    expect(parseLocalIdentity(findIdentityOutput([`${HASH_A} "${LOCAL_SIGNING_NAME}"`]))).toEqual({ kind: 'one', hash: HASH_A });
  });

  it('finds none when only other identities are there, or a name that only starts the same', () => {
    expect(parseLocalIdentity(findIdentityOutput([`${OTHER} "Apple Development: Someone (TEAM)"`, `${HASH_A} "${LOCAL_SIGNING_NAME} 2"`]))).toEqual({ kind: 'none' });
    expect(parseLocalIdentity('')).toEqual({ kind: 'none' });
  });

  it('leaves out an expired or revoked certificate', () => {
    expect(parseLocalIdentity(findIdentityOutput([ours(HASH_A, 'CSSMERR_TP_CERT_EXPIRED'), ours(HASH_B)]))).toEqual({ kind: 'one', hash: HASH_B });
    expect(parseLocalIdentity(findIdentityOutput([ours(HASH_A, 'CSSMERR_TP_CERT_REVOKED')]))).toEqual({ kind: 'none' });
  });

  it('reports several, since each would give builds a different requirement', () => {
    expect(parseLocalIdentity(findIdentityOutput([ours(HASH_A), ours(HASH_B)]))).toEqual({ kind: 'many', hashes: [HASH_A, HASH_B] });
  });

  it('counts an identity listed in both lists once', () => {
    const output = findIdentityOutput([`${HASH_A} "${LOCAL_SIGNING_NAME}"`]).replace(`${OTHER} "Apple Development: Someone (TEAM)"`, `${HASH_A} "${LOCAL_SIGNING_NAME}"`);
    expect(parseLocalIdentity(output)).toEqual({ kind: 'one', hash: HASH_A });
  });
});

/** A fake `security`/`codesign`/`openssl`: records each call and answers from `answer`, or succeeds with no output. */
function fakeRun(answer: (command: string, args: readonly string[]) => Partial<ReturnType<Run>> | undefined = () => undefined) {
  const calls: string[] = [];
  const exec: Run = (command, args) => {
    calls.push([command, ...args].join(' '));
    return { status: 0, stdout: '', stderr: '', ...answer(command, args) };
  };
  return { calls, exec };
}

describe('signApp', () => {
  it('keeps the ad hoc signature without a local identity, and says how to set one up', () => {
    const logs: string[] = [];
    const { calls, exec } = fakeRun((command, args) => (args[0] === 'find-identity' ? { stdout: findIdentityOutput([]) } : undefined));
    expect(signApp('/built/agent-board.app', (m) => logs.push(m), exec)).toBe('adhoc');
    expect(calls).toEqual(['security find-identity -p codesigning']);
    expect(logs).toEqual([expect.stringContaining('pnpm signing:setup')]);
  });

  it('keeps the ad hoc signature when `security` fails', () => {
    const { calls, exec } = fakeRun((_, args) => (args[0] === 'find-identity' ? { status: 1, stderr: 'no keychain' } : undefined));
    expect(signApp('/built/agent-board.app', () => {}, exec)).toBe('adhoc');
    expect(calls).toHaveLength(1);
  });

  it('keeps the ad hoc signature, and names them, when there are several local identities', () => {
    const logs: string[] = [];
    const { calls, exec } = fakeRun((_, args) => (args[0] === 'find-identity' ? { stdout: findIdentityOutput([ours(HASH_A), ours(HASH_B)]) } : undefined));
    expect(signApp('/built/agent-board.app', (m) => logs.push(m), exec)).toBe('adhoc');
    expect(calls).toHaveLength(1);
    expect(logs[0]).toContain(HASH_B);
  });

  it('signs the whole bundle with the identity by hash, verifies it, and logs the designated requirement', () => {
    const logs: string[] = [];
    const requirement = `identifier "io.github.garethca.agent-board" and certificate leaf = H"${HASH_A.toLowerCase()}"`;
    const { calls, exec } = fakeRun((_, args) => {
      if (args[0] === 'find-identity') return { stdout: findIdentityOutput([ours(HASH_A)]) };
      if (args[0] === '-d') return { stdout: `Executable=/built/agent-board.app/Contents/MacOS/agent-board\ndesignated => ${requirement}\n` };
      return undefined;
    });
    expect(signApp('/built/agent-board.app', (m) => logs.push(m), exec)).toBe('local');
    expect(calls).toEqual([
      'security find-identity -p codesigning',
      `codesign --force --deep --sign ${HASH_A} /built/agent-board.app`,
      'codesign --verify --deep --strict /built/agent-board.app',
      'codesign -d -r- /built/agent-board.app',
    ]);
    // No hardened runtime: node-pty and the agents' CLIs run as they did under the ad hoc signature.
    expect(calls.join('\n')).not.toContain('runtime');
    expect(logs).toEqual([`signed with "${LOCAL_SIGNING_NAME}": ${requirement}`]);
  });

  it('throws when codesign fails, so the build is never installed half-signed', () => {
    const { exec } = fakeRun((command, args) => {
      if (args[0] === 'find-identity') return { stdout: findIdentityOutput([ours(HASH_A)]) };
      if (command === 'codesign' && args[0] === '--verify') return { status: 1, stderr: 'a sealed resource is missing or invalid' };
      return undefined;
    });
    expect(() => signApp('/built/agent-board.app', () => {}, exec)).toThrow(/codesign --verify failed \(exit 1\): a sealed resource.*\n.*security unlock-keychain/);
  });
});

describe('setUpLocalSigning', () => {
  function machine(answer: Parameters<typeof fakeRun>[0]) {
    const { calls, exec } = fakeRun(answer);
    const logs: string[] = [];
    const dirs: string[] = [];
    return {
      calls,
      logs,
      dirs,
      machine: {
        exec,
        makeTempDir: () => {
          const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-signing-')));
          onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
          dirs.push(dir);
          return dir;
        },
        removeDir: (dir: string) => rmSync(dir, { recursive: true, force: true }),
        log: (m: string) => logs.push(m),
      },
    };
  }

  it('does nothing when the identity is there already', () => {
    const { calls, logs, dirs, machine: m } = machine((_, args) => (args[0] === 'find-identity' ? { stdout: findIdentityOutput([ours(HASH_A)]) } : undefined));
    expect(setUpLocalSigning(m)).toEqual({ kind: 'one', hash: HASH_A });
    expect(calls).toEqual(['security find-identity -p codesigning']);
    expect(dirs).toEqual([]);
    expect(logs[0]).toContain('already set up');
  });

  it('makes a code-signing certificate, imports it for codesign, tries it once, and removes the key files', () => {
    let imported = false;
    const { calls, dirs, machine: m } = machine((command, args) => {
      if (args[0] === 'find-identity') return { stdout: findIdentityOutput(imported ? [ours(HASH_A)] : []) };
      if (command === 'security' && args[0] === 'import') imported = true;
      return undefined;
    });
    expect(setUpLocalSigning(m)).toEqual({ kind: 'one', hash: HASH_A });
    const [dir] = dirs;
    expect(calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'security find-identity',
      '/usr/bin/openssl req',
      '/usr/bin/openssl pkcs12',
      'security import',
      'security find-identity',
      'codesign --force',
    ]);
    expect(calls[1]).toContain(`/CN=${LOCAL_SIGNING_NAME}`);
    expect(calls[1]).toContain('extendedKeyUsage=critical,codeSigning');
    expect(calls[3]).toContain('-T /usr/bin/codesign');
    expect(calls[5]).toBe(`codesign --force --sign ${HASH_A} ${join(dir!, 'probe')}`);
    expect(existsSync(dir!)).toBe(false);
  });

  it('says how to clean up when the imported certificate is not found', () => {
    const { machine: m } = machine((_, args) => (args[0] === 'find-identity' ? { stdout: findIdentityOutput([]) } : undefined));
    expect(() => setUpLocalSigning(m)).toThrow(/Delete it in Keychain Access.*then run `pnpm signing:setup` again/);
  });

  it('says how to unlock or start over when codesign cannot use the new key', () => {
    let imported = false;
    const { machine: m } = machine((command, args) => {
      if (args[0] === 'find-identity') return { stdout: findIdentityOutput(imported ? [ours(HASH_A)] : []) };
      if (command === 'security' && args[0] === 'import') imported = true;
      if (command === 'codesign') return { status: 1, stderr: 'errSecInternalComponent' };
      return undefined;
    });
    expect(() => setUpLocalSigning(m)).toThrow(new RegExp(`errSecInternalComponent\\n.*security unlock-keychain.*security delete-identity -Z ${HASH_A}`));
  });

  it('stops at the failing step, and still removes the key files', () => {
    const { calls, dirs, machine: m } = machine((command, args) => {
      if (args[0] === 'find-identity') return { stdout: findIdentityOutput([]) };
      if (command === 'security' && args[0] === 'import') return { status: 1, stderr: 'User interaction is not allowed.' };
      return undefined;
    });
    expect(() => setUpLocalSigning(m)).toThrow(/security import failed \(exit 1\): User interaction is not allowed/);
    expect(calls.at(-1)).toMatch(/^security import /);
    expect(existsSync(dirs[0]!)).toBe(false);
  });
});
