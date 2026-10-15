import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasClaudeTranscript } from '../src/claude-transcript.ts';
import { tempDataDir } from './helpers.ts';

describe('hasClaudeTranscript', () => {
  const cwd = '/work/my repo';
  const id = 'abc-123';
  const save = (configDir: string) => {
    const file = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{}\n');
    return file;
  };

  it('has the transcript its hooks named while that file is there', () => {
    const recorded = join(tempDataDir(), 'elsewhere.jsonl');
    writeFileSync(recorded, '{}\n');
    expect(hasClaudeTranscript(recorded, id, cwd, { HOME: tempDataDir() })).toBe(true);
  });

  it('looks under the cwd when the recorded file is gone, or nothing was recorded', () => {
    const home = tempDataDir();
    save(join(home, '.claude'));
    expect(hasClaudeTranscript(join(home, 'gone.jsonl'), id, cwd, { HOME: home })).toBe(true);
    expect(hasClaudeTranscript(null, id, cwd, { HOME: home })).toBe(true);
  });

  it('has none when the recorded file is gone and nothing is under the cwd', () => {
    expect(hasClaudeTranscript(join(tempDataDir(), 'gone.jsonl'), id, cwd, { HOME: tempDataDir() })).toBe(false);
    expect(hasClaudeTranscript(null, id, cwd, { HOME: tempDataDir() })).toBe(false);
  });

  it('honours CLAUDE_CONFIG_DIR over ~/.claude', () => {
    const home = tempDataDir();
    const configDir = tempDataDir();
    save(configDir);
    expect(hasClaudeTranscript(null, id, cwd, { HOME: home, CLAUDE_CONFIG_DIR: configDir })).toBe(true);
    // The same file under ~/.claude is not what Claude would read with the variable set.
    const other = tempDataDir();
    save(join(other, '.claude'));
    expect(hasClaudeTranscript(null, id, cwd, { HOME: other, CLAUDE_CONFIG_DIR: tempDataDir() })).toBe(false);
  });
});
