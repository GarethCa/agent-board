import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Check, Copy, RotateCw, SquareTerminal } from 'lucide-react';
import { APP_NAME } from '../../../shared/brand';
import { errorMessage } from '../../../shared/errors';
import { Captain } from '../board/Character';
import { Button, ErrorText } from '../ui';
import { CLAUDE_PLANS_URL, claudeInstallCommand, claudeReadiness, shellQuote, SIGN_IN_ARGS, type ClaudeReadiness } from './first-run';
import { useToolChecks } from './use-tool-checks';

/**
 * The Simplified design's first step: the Captain says who it is and what comes next, with one line on what the app
 * is. Skip goes to the board.
 */
export function CaptainWelcomeStep({ progress, onSkip, onNext }: { progress: ReactNode; onSkip(): void; onNext(): void }) {
  return (
    <section className="onboarding-card captain-step captain-welcome" role="dialog" aria-modal="true" aria-labelledby="captain-welcome-title">
      <div className="captain-welcome-figure">
        <Captain size="first-run" />
      </div>
      <h1 id="captain-welcome-title" className="captain-step-title">
        Ahoy! I&rsquo;m the Captain.
      </h1>
      <p className="captain-step-lead">I&rsquo;ll get Claude ready, then keep an eye on your agents.</p>
      <p className="captain-step-note">{APP_NAME} shows every Claude task in one place and tells you when one needs you.</p>
      <footer className="captain-step-foot">
        {progress}
        <span className="onboarding-foot-gap" />
        <Button variant="ghost" onClick={onSkip}>
          Skip
        </Button>
        <Button variant="primary" trailingIcon={<ArrowRight />} onClick={onNext} autoFocus>
          Get started
        </Button>
      </footer>
    </section>
  );
}

export interface ClaudeReadyStepProps {
  progress: ReactNode;
  /** Opens a terminal on the board, running `command` when given, and sets onboarding aside until the user is back. */
  onTerminal(command?: string): void;
  onOpenLink(url: string): void;
  onBack(): void;
  onSkip(): void;
  onNext(): void;
}

/**
 * The Simplified design's second step: is Claude Code installed, and signed in? Each row checks itself when the step
 * opens. Installing is the user's to run: the step shows Anthropic's command to copy, and opens a terminal with nothing
 * typed in it. Signing in runs Claude Code's own sign-in in a terminal, on the user's click, as Classic's Sign in does.
 */
export function ClaudeReadyStep({ progress, onTerminal, onOpenLink, onBack, onSkip, onNext }: ClaudeReadyStepProps) {
  const { checks, failed, check } = useToolChecks();
  const ask = useCallback(() => check('claude'), [check]);
  useEffect(ask, [ask]);

  const readiness = claudeReadiness(checks.claude, failed.claude);
  const found = readiness.installed === 'yes' && checks.claude?.found ? checks.claude.path : undefined;
  const signInCommand = found === undefined ? undefined : `${shellQuote(found)} ${SIGN_IN_ARGS.claude}`;
  const checkAgain = (
    <Button variant="ghost" size="sm" icon={<RotateCw />} onClick={ask}>
      Check again
    </Button>
  );

  return (
    <section className="onboarding-card captain-step captain-ready" role="dialog" aria-modal="true" aria-labelledby="captain-ready-title">
      <header className="captain-ready-head">
        <span className="captain-ready-figure">
          <Captain size="avatar" />
        </span>
        <div>
          <h1 id="captain-ready-title" className="captain-step-title">
            Let&rsquo;s get Claude ready
          </h1>
          <p className="captain-step-lead">First, {APP_NAME} needs Claude Code: the version of Claude that can work on files.</p>
        </div>
      </header>
      <ul className="captain-checks">
        <ReadyRow
          name="Claude Code"
          state={INSTALL_ROW_STATE[readiness.installed]}
          title={INSTALL_ROW_TITLE[readiness.installed]}
        >
          {readiness.installed === 'no' && (
            <>
              <p className="captain-check-detail">Copy this command, paste it into a terminal and press Return. It takes about a minute.</p>
              <CopyCommand command={INSTALL_COMMAND} />
              <div className="captain-check-actions">
                <Button icon={<SquareTerminal />} onClick={() => onTerminal()}>
                  Open Terminal
                </Button>
                {checkAgain}
              </div>
            </>
          )}
          {readiness.installed === 'unknown' && (
            <>
              <ErrorText className="captain-check-detail">Claude Code {readiness.problem}</ErrorText>
              <div className="captain-check-actions">{checkAgain}</div>
            </>
          )}
        </ReadyRow>
        <ReadyRow
          name="Sign in"
          state={readiness.signedIn === 'yes' ? 'done' : readiness.signedIn === 'waiting' ? 'waiting' : 'todo'}
          title={readiness.signedIn === 'yes' ? 'Signed in to Claude' : 'Sign in to Claude'}
        >
          {readiness.signedIn === 'no' && signInCommand !== undefined && (
            <>
              <p className="captain-check-detail">
                Claude Code&rsquo;s sign-in opens in your browser. You&rsquo;ll need a Claude plan or an API key.{' '}
                <button type="button" className="captain-link" onClick={() => onOpenLink(CLAUDE_PLANS_URL)}>
                  Which plans work?
                </button>
              </p>
              <div className="captain-check-actions">
                <Button variant="primary" icon={<SquareTerminal />} onClick={() => onTerminal(signInCommand)}>
                  Sign in
                </Button>
                {checkAgain}
              </div>
            </>
          )}
          {readiness.signedIn === 'problem' && (
            <>
              <ErrorText className="captain-check-detail">Claude Code {readiness.problem}</ErrorText>
              <div className="captain-check-actions">{checkAgain}</div>
            </>
          )}
        </ReadyRow>
      </ul>
      <footer className="captain-step-foot">
        {progress}
        <span className="onboarding-foot-gap" />
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {!readiness.ready && <Button onClick={onSkip}>Skip for now</Button>}
        <Button variant="primary" trailingIcon={<ArrowRight />} disabled={!readiness.ready} onClick={onNext}>
          Continue
        </Button>
      </footer>
    </section>
  );
}

/** A row's mark: ticked, to do, still being checked, or waiting on the row above. */
type ReadyRowState = 'done' | 'todo' | 'checking' | 'waiting';

const INSTALL_ROW_STATE: Record<ClaudeReadiness['installed'], ReadyRowState> = { checking: 'checking', yes: 'done', no: 'todo', unknown: 'todo' };

const INSTALL_ROW_TITLE: Record<ClaudeReadiness['installed'], string> = {
  checking: 'Looking for Claude Code…',
  yes: 'Claude Code is installed',
  no: 'Claude Code isn’t installed yet',
  unknown: 'Couldn’t check for Claude Code',
};

/** Anthropic's installer for this platform: the command the install row shows to copy. */
const INSTALL_COMMAND = claudeInstallCommand(navigator.platform.startsWith('Win'));

const STATE_LABELS: Record<ReadyRowState, string> = { done: 'Done', todo: 'To do', checking: 'Checking', waiting: 'Not yet' };

function ReadyRow({ name, state, title, children }: { name: string; state: ReadyRowState; title: string; children?: ReactNode }) {
  return (
    <li className="captain-check" data-state={state} aria-label={name}>
      <span className="captain-check-mark" role="img" aria-label={STATE_LABELS[state]}>
        {state === 'done' && <Check />}
        {state === 'todo' && <AlertCircle />}
      </span>
      <div className="captain-check-body">
        <span className="captain-check-title">{title}</span>
        {children}
      </div>
    </li>
  );
}

/** A command shown whole, to copy and paste into a terminal: the app never runs it. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string>();
  const copy = () => {
    navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      (error: unknown) => setProblem(`Could not copy: ${errorMessage(error)}`),
    );
  };
  return (
    <>
      <div className="captain-command">
        <code aria-label="Install command">{command}</code>
        <Button size="sm" icon={copied ? <Check /> : <Copy />} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {problem !== undefined && <ErrorText className="captain-check-detail">{problem}</ErrorText>}
    </>
  );
}
