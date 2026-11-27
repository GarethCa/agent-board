import { describe, expect, it } from 'vitest';
import { parseEnvLines } from './launch-env';

describe('parseEnvLines', () => {
  it('reads one NAME=value a line, skipping blanks and comments, and keeps the value as typed', () => {
    expect(parseEnvLines('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0\r\n\n# a note\n  DEBUG= a=b \n')).toEqual({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '0', DEBUG: ' a=b ' } });
  });

  it('reads nothing typed as no env', () => {
    expect(parseEnvLines('  \n')).toEqual({ env: {} });
  });

  it('keeps an empty value, and the later line for a name', () => {
    expect(parseEnvLines('A=1\nA=\n')).toEqual({ env: { A: '' } });
  });

  it('says which line is not NAME=value, as agent-board --env refuses it', () => {
    expect(parseEnvLines('A=1\nNOEQUALS')).toEqual({ error: 'Line 2 isn\'t NAME=value: "NOEQUALS".' });
    expect(parseEnvLines('=1')).toEqual({ error: "Line 1 isn't NAME=value: it has no name." });
    expect(parseEnvLines('1A=x')).toEqual({ error: 'Line 1 isn\'t NAME=value: "1A".' });
    expect(parseEnvLines('A =x')).toEqual({ error: 'Line 1 isn\'t NAME=value: "A ".' });
  });
});
