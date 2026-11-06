// Words for a command line someone, or an agent, will type at a shell: each one word, never read as an option, a
// substitution or a glob.

/** `word` as one shell word: bare when it is plain, else single-quoted, with its own quotes escaped. */
export function shellQuote(word: string): string {
  return /^[\w:.@/-]+$/.test(word) && !word.startsWith('-') ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
