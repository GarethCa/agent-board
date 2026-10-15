/** `word` with its first letter a capital: a lower-case name as a label or a sentence's start. */
export const upperFirst = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
