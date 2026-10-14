import { codexInvocation } from '../codex.ts';
import { runFakeCli } from './run.ts';

await runFakeCli('codex', () => codexInvocation(process.argv.slice(2), process.env, process.cwd()));
