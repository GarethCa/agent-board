import { useCallback, useRef, useState } from 'react';
import type { SetupTool, ToolCheck } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';

/**
 * Asks the daemon whether each CLI is installed and signed in, the latest ask of each winning: an older one's answer,
 * arriving after, is dropped. A tool is unknown (checking) from each ask until it answers.
 *
 * A check that fails (the daemon or IPC, not the CLI) answers as a CLI that could not be asked, so a row never reads as
 * still being checked; `failed` says so apart, with why, for a row that must not claim the CLI was found.
 */
export function useToolChecks(): {
  checks: Partial<Record<SetupTool, ToolCheck>>;
  failed: Partial<Record<SetupTool, string>>;
  check(tool: SetupTool): void;
} {
  const [checks, setChecks] = useState<Partial<Record<SetupTool, ToolCheck>>>({});
  const [failed, setFailed] = useState<Partial<Record<SetupTool, string>>>({});
  const latest = useRef<Partial<Record<SetupTool, number>>>({});

  const check = useCallback((tool: SetupTool) => {
    const asked = (latest.current[tool] ?? 0) + 1;
    latest.current[tool] = asked;
    setChecks((current) => ({ ...current, [tool]: undefined }));
    setFailed((current) => ({ ...current, [tool]: undefined }));
    const current = () => latest.current[tool] === asked;
    window.agentBoard.setup.check(tool).then(
      (found) => {
        if (current()) setChecks((all) => ({ ...all, [tool]: found }));
      },
      (error: unknown) => {
        if (!current()) return;
        const why = `could not be checked: ${errorMessage(error)}`;
        setFailed((all) => ({ ...all, [tool]: why }));
        setChecks((all) => ({ ...all, [tool]: { tool, found: true, path: tool, problem: why } }));
      },
    );
  }, []);

  return { checks, failed, check };
}
