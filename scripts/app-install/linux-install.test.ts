import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { aptInstallCommand, builderTargetArgs, DEB_EXECUTABLE, installDeb, isAppMain, launch, linuxPackages, linuxProcesses, type InstallDebOptions, type LinuxMachine, type LinuxProcess } from './linux-install.ts';

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-linux-install-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('linuxPackages', () => {
  it('finds the one .deb and tar.gz electron-builder left in dist/', () => {
    const desktop = tempDir();
    mkdirSync(join(desktop, 'dist', 'linux-unpacked'), { recursive: true });
    for (const file of ['agent-board-0.0.0-amd64.deb', 'agent-board-0.0.0-x64.tar.gz', 'builder-debug.yml']) writeFileSync(join(desktop, 'dist', file), '');
    expect(linuxPackages(desktop)).toEqual({ deb: join(desktop, 'dist', 'agent-board-0.0.0-amd64.deb'), tarball: join(desktop, 'dist', 'agent-board-0.0.0-x64.tar.gz') });
  });

  it('finds the tar.gz alone where only that was built', () => {
    const desktop = tempDir();
    mkdirSync(join(desktop, 'dist'));
    writeFileSync(join(desktop, 'dist', 'agent-board-0.0.0-x64.tar.gz'), '');
    expect(linuxPackages(desktop)).toEqual({ deb: undefined, tarball: join(desktop, 'dist', 'agent-board-0.0.0-x64.tar.gz') });
  });

  it('says to build first when there is nothing, and to build again when there are two', () => {
    const desktop = tempDir();
    expect(() => linuxPackages(desktop)).toThrow('no .tar.gz');
    mkdirSync(join(desktop, 'dist'));
    for (const file of ['agent-board-0.0.0-x64.tar.gz', 'agent-board-0.0.0-amd64.deb', 'agent-board-0.0.0-arm64.deb']) writeFileSync(join(desktop, 'dist', file), '');
    expect(() => linuxPackages(desktop)).toThrow('more than one .deb');
  });
});

describe('builderTargetArgs', () => {
  it("builds the config's targets, except the tar.gz alone on Linux without apt", () => {
    expect(builderTargetArgs('darwin', false)).toEqual([]);
    expect(builderTargetArgs('linux', true)).toEqual([]);
    expect(builderTargetArgs('linux', false)).toEqual(['--linux', 'tar.gz']);
  });
});

describe('launch', () => {
  it('hands a failure to start to its error handler, rather than crashing', async () => {
    const error = await new Promise<Error>((done) => launch(join(tempDir(), 'agent-board'), done));
    expect(error.message).toContain('ENOENT');
  });
});

describe('linuxProcesses', () => {
  const me = 1000;

  /** `uids` is the status file's Uid: line: real, effective, saved and filesystem. */
  function fakeProc(procDir: string, pid: string, exe: string, argv: string[], env: string[], uids = [me, me, me, me]) {
    const dir = join(procDir, pid);
    mkdirSync(dir);
    writeFileSync(join(dir, 'status'), `Name:\tagent-board\nUmask:\t0022\nUid:\t${uids.join('\t')}\nGid:\t${me}\t${me}\t${me}\t${me}\n`);
    symlinkSync(exe, join(dir, 'exe'));
    writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    writeFileSync(join(dir, 'environ'), `${env.join('\0')}\0`);
  }

  it('reads each process from /proc, and skips what is not a process or not readable', () => {
    const procDir = tempDir();
    fakeProc(procDir, '42', DEB_EXECUTABLE, [DEB_EXECUTABLE, '--type=renderer'], ['HOME=/home/me']);
    mkdirSync(join(procDir, '43')); // another user's: no exe to read
    mkdirSync(join(procDir, 'self'));
    writeFileSync(join(procDir, 'uptime'), '');

    expect(linuxProcesses(procDir, me)).toEqual([{ pid: 42, exe: DEB_EXECUTABLE, args: ['--type=renderer'], env: ['HOME=/home/me'] }]);
  });

  it("goes by the real uid: another user's process is left out, even one it can read", () => {
    const procDir = tempDir();
    fakeProc(procDir, '42', DEB_EXECUTABLE, [DEB_EXECUTABLE], ['HOME=/home/me']);
    fakeProc(procDir, '44', DEB_EXECUTABLE, [DEB_EXECUTABLE], ['HOME=/home/me'], [1001, 1001, 1001, 1001]);
    fakeProc(procDir, '45', DEB_EXECUTABLE, [DEB_EXECUTABLE], ['HOME=/home/me'], [me, 0, 0, 0]);
    fakeProc(procDir, '46', DEB_EXECUTABLE, [DEB_EXECUTABLE], ['HOME=/home/me'], [1001, me, me, me]);

    expect(linuxProcesses(procDir, me).map((proc) => proc.pid).sort()).toEqual([42, 45]);
  });
});

describe('isAppMain', () => {
  const proc = (overrides: Partial<LinuxProcess>): LinuxProcess => ({ pid: 1, exe: DEB_EXECUTABLE, args: [], env: ['HOME=/home/me'], ...overrides });

  it('is the window process of the installed app', () => {
    expect(isAppMain(proc({}), DEB_EXECUTABLE)).toBe(true);
  });

  it('is never a Chromium helper, the daemon or the hook forwarder, which run the same executable', () => {
    expect(isAppMain(proc({ args: ['--type=zygote', '--no-zygote-sandbox'] }), DEB_EXECUTABLE)).toBe(false);
    expect(isAppMain(proc({ args: ['/opt/agent-board/resources/app/out/main/daemon.js'], env: ['ELECTRON_RUN_AS_NODE=1'] }), DEB_EXECUTABLE)).toBe(false);
  });

  it('is never another program, such as a dev build of the app', () => {
    expect(isAppMain(proc({ exe: '/home/me/agent-board/node_modules/electron/dist/electron' }), DEB_EXECUTABLE)).toBe(false);
  });
});

describe('aptInstallCommand', () => {
  it('reinstalls through sudo, since every build has the same version', () => {
    expect(aptInstallCommand('/src/dist/a.deb', 1000)).toEqual({ command: 'sudo', args: ['apt-get', 'install', '--reinstall', '-y', '/src/dist/a.deb'] });
  });

  it('runs apt itself as root, where there may be no sudo', () => {
    expect(aptInstallCommand('/src/dist/a.deb', 0)).toEqual({ command: 'apt-get', args: ['install', '--reinstall', '-y', '/src/dist/a.deb'] });
  });
});

describe('installDeb', () => {
  function setup(running: number, overrides: Partial<InstallDebOptions> = {}, machineOverrides: Partial<LinuxMachine> = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    let polls = running;
    const options: InstallDebOptions = {
      deb: '/src/dist/agent-board-0.0.0-amd64.deb',
      tarball: '/src/dist/agent-board-0.0.0-x64.tar.gz',
      open: false,
      confirm: async (question) => (calls.push(`ask: ${question}`), true),
      log: (message) => logs.push(message),
      ...overrides,
    };
    const machine: LinuxMachine = {
      running: () => polls-- > 0,
      quit: () => void calls.push('quit'),
      sleep: async () => {},
      hasApt: () => true,
      sudoUser: () => undefined,
      install: (deb) => void calls.push(`install ${deb}`),
      open: () => void calls.push('open'),
      ...machineOverrides,
    };
    return { options, machine, calls, logs };
  }

  it('installs the .deb without quitting or opening an app that is not running', async () => {
    const { options, machine, calls, logs } = setup(0);
    await expect(installDeb(options, machine)).resolves.toBe(true);
    expect(calls).toEqual([`install ${options.deb}`]);
    expect(logs.at(-1)).toBe('Installed agent-board in /opt/agent-board; `agent-board` opens it.');
  });

  it('quits a running app before apt replaces it, and reopens it when told yes', async () => {
    const { options, machine, calls } = setup(3);
    await installDeb(options, machine);
    expect(calls).toEqual(['quit', `install ${options.deb}`, 'ask: agent-board was running. Reopen it?', 'open']);
  });

  it('leaves the app closed when told not to reopen it, and says how to open it', async () => {
    const { options, machine, calls, logs } = setup(2, { confirm: async () => false });
    await installDeb(options, machine);
    expect(calls).toEqual(['quit', `install ${options.deb}`]);
    expect(logs.at(-1)).toContain('Open it from your app menu, or run `agent-board`, when you are ready');
  });

  it('reopens the app it quit when apt fails, and passes the failure on', async () => {
    const { options, machine, calls } = setup(2, {}, {
      install: () => {
        throw new Error('sudo apt-get failed (exit 100)');
      },
    });
    await expect(installDeb(options, machine)).rejects.toThrow('exit 100');
    expect(calls).toEqual(['quit', 'open']);
  });

  it('installs nothing without apt, and says what it built', async () => {
    const { options, machine, calls, logs } = setup(2, { deb: undefined }, { hasApt: () => false });
    await expect(installDeb(options, machine)).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain(`Built ${options.tarball}`);
    expect(logs.join('\n')).toContain('unpack the tar.gz');
  });

  it('refuses under sudo before quitting anything, so the app is never reopened as root', async () => {
    const { options, machine, calls } = setup(2, {}, { sudoUser: () => 'me' });
    await expect(installDeb(options, machine)).rejects.toThrow('run `pnpm package` as me, not through sudo');
    expect(calls).toEqual([]);
  });
});
