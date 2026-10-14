// `agent-board daemon`: the app's own executable, run as Node (ADR-0001), with the daemon subcommand.
import { runAgentBoardCli } from '@agent-board/daemon';
import type { BuildInfo } from '@agent-board/daemon/protocol';
import { BUILD } from './build';

// e2e tests start a daemon that claims another build, as one left running across an upgrade would.
const fakeBuild = process.env.AGENT_BOARD_FAKE_DAEMON_BUILD;
const build: BuildInfo = fakeBuild ? JSON.parse(fakeBuild) : BUILD;

process.exitCode = await runAgentBoardCli(process.argv.slice(2), { build });
