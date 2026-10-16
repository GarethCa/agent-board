import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { alive, killAll } from '../src/processes.ts';

describe('killAll', () => {
  it('terminates a process that ignores SIGTERM with SIGKILL', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => child.stdout!.once('data', r));
    const closed = new Promise((r) => child.on('close', r));
    await killAll([{ pid: child.pid!, ppid: 1, command: '' }], 300);
    await closed;
    expect(child.signalCode).toBe('SIGKILL');
  });
});

describe('alive', () => {
  it('is true for a running process and false once it has exited and been reaped', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { stdio: 'ignore' });
    expect(alive(child.pid!)).toBe(true);
    await new Promise((r) => child.on('close', r));
    expect(alive(child.pid!)).toBe(false);
  });
});
