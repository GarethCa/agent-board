/**
 * Long strings for checking that text keeps to its box: the stress gallery fills every field with them. Each is a kind of
 * text that breaks a layout in its own way.
 */

/** 300 characters with no space to break at. */
export const NO_SPACES = 'Averylongnamewithnospacesatall'.repeat(10);

/** A path deep enough to be wider than any tile. */
export const LONG_PATH = '/Users/ada/code/projects/a-repository-with-a-long-name/packages/a-package-with-a-long-name/src/renderer/components/deeply/nested/folder/FileWithAVeryLongName.test.tsx';

/** A URL with a query and a fragment, and no space in it. */
export const LONG_URL = 'https://example.test/an-organisation-with-a-long-name/a-repository-with-a-long-name/pull/12345/files?diff=split&w=1#diff-0123456789abcdef0123456789abcdef0123456789';

/** Long words in other scripts: German, Russian, Japanese (which has no spaces) and Arabic. */
export const OTHER_SCRIPTS = 'Donaudampfschifffahrtsgesellschaftskapitänsmütze Достопримечательностьдостопримечательность 長い日本語の文章は空白なしでどこまでも続いていきます長い日本語の文章は空白なしで続きます مستشفياتالمدينةالجامعيةالكبيرةالجديدة';

/** Emoji, some joined into one glyph, with no space between them. */
export const EMOJI = '🚀🔥✨🧪🧵🪄👩‍👩‍👧‍👦🏳️‍🌈🧑🏽‍💻'.repeat(6);

/** An ordinary sentence, only very long. */
export const LONG_SENTENCE = 'Find out why the checkout test fails on the build machine but passes on every laptop we have tried it on, then fix it and write down what we learned so the next person does not lose a day to it';
