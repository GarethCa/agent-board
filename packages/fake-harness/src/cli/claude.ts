import { claudeInvocation } from '../claude.ts';
import { runFakeCli } from './run.ts';

await runFakeCli('claude', () => claudeInvocation(process.argv.slice(2), process.env, process.cwd()));
