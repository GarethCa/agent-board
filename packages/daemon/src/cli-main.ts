// `agent-board …` run straight from source by Node, as the CLI launcher runs it in the daemon's tests. (The app runs it
// through its own bundled entry, apps/desktop/src/main/daemon.ts.)
import { runAgentBoardCli } from './cli.ts';

process.exitCode = await runAgentBoardCli(process.argv.slice(2));
