// `agent-board hook …` run straight from source by Node, as the daemon's tests run the hook forwarder. (The app runs
// it through its own bundled entry, apps/desktop/src/main/daemon.ts, which can also load the daemon.)
import { runHookCommand } from './hook-forwarder.ts';

// The shim passes `hook <args>`.
process.exitCode = await runHookCommand(process.argv.slice(3));
