import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesNamingTickets, TEAM } from './ticket-ids.ts';

// Joined, so this file does not itself name a ticket for the release's leak check.
const ticket = (n: number): string => [TEAM, n].join('-');

describe('filesNamingTickets', () => {
  it('finds the changed text files that name a ticket, and skips the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'ticket-ids-'));
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'bare.ts'), `// saved in pixels by ${ticket(111)}\n`);
    writeFileSync(join(root, 'clean.ts'), '// saved in pixels by an earlier build\n');
    writeFileSync(join(root, 'word.ts'), `const PRO${ticket(1)} = 1; // JARVIS-2\n`);
    writeFileSync(join(root, 'image.png'), ticket(5));

    expect(filesNamingTickets(['bare.ts', 'clean.ts', 'word.ts', 'image.png', 'gone.ts', 'dir'], root)).toEqual(['bare.ts']);
  });
});
