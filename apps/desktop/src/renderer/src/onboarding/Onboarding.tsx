import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useSimplified } from '../design';
import { Button } from '../ui';
import { CaptainWelcomeStep, ClaudeReadyStep } from './CaptainSteps';
import { ConnectStep } from './ConnectStep';
import { FinishStep } from './FinishStep';
import { ONBOARDING_STEPS, SIMPLIFIED_STEPS, STEP_LABELS, type OnboardingEnd, type OnboardingStep } from './first-run';
import { QuickTour } from './QuickTour';
import { WelcomeStep } from './WelcomeStep';

/** What Tab moves between inside onboarding. */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export interface OnboardingProps {
  /** Whether the board menu keeps its Getting started row: the Finish step's checkbox. */
  showInMenu: boolean;
  onShowInMenu(show: boolean): void;
  /**
   * Opens a new shell tile and shows its window, running `command` in it when given (a CLI's sign-in); resolves with
   * the window's id, if it started.
   */
  onSignIn(command?: string): Promise<string | undefined>;
  /** The user is back from a sign-in: closes its window, leaving the shell tile on the board. */
  onSignedIn(windowId: string): void;
  /** Opens a link in the browser. */
  onOpenLink(url: string): void;
  /** Onboarding is over, finished or skipped at any step; it doesn't open by itself again. */
  onEnd(end: OnboardingEnd): void;
}

/**
 * First-run onboarding (mocks X–AA): Welcome, Connect your tools, a quick tour of the board, then Finish. Under
 * the Simplified design it is two steps instead: the Captain says hello, then gets Claude ready. Every
 * step can be skipped, and Help › Getting started brings it back. While it is open the board's keys are its own: no
 * shortcut reaches the board under it. Signing in to a CLI sets it aside for the shell tile that runs the sign-in,
 * with a pill to come back by.
 */
export function Onboarding({ showInMenu, onShowInMenu, onSignIn, onSignedIn, onOpenLink, onEnd }: OnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  /** Set aside for a sign-in in a shell tile; coming back checks again. */
  const [away, setAway] = useState(false);
  /** The sign-in's shell window, closed on coming back so the tour has the board to itself. */
  const signInWindow = useRef<string>(undefined);
  const [checked, setChecked] = useState(0);
  const simplified = useSimplified();
  const steps: readonly OnboardingStep[] = simplified ? SIMPLIFIED_STEPS : ONBOARDING_STEPS;
  const go = (to: OnboardingStep) => setStep(to);
  const at = steps.indexOf(step);
  const next = () => go(steps[at + 1] ?? 'finish');
  const back = () => go(steps[Math.max(at - 1, 0)]!);
  const escape = useRef<() => void>(() => {});
  // Under the Simplified design every Esc ends it: it has no tour to skip, even when turned on mid-tour.
  escape.current = step === 'tour' && !simplified ? () => go('finish') : () => onEnd('board');
  /** Sets onboarding aside for a shell tile (a sign-in, or a terminal to install in); coming back checks again. */
  const runInShell = (command?: string) => {
    setAway(true);
    void onSignIn(command).then((id) => {
      signInWindow.current = id;
      // It never started (said why in a notice): nothing to wait for.
      if (id === undefined) setAway(false);
    });
  };

  // Focus goes back to where it was once onboarding is over.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // While onboarding is up: Esc skips the tour, or onboarding; Tab stays inside it (the steps are modal); and no key
  // reaches the board's own shortcuts, wherever focus is. Typing in a field is left to the field, whose keys the board
  // ignores anyway, so handlers inside onboarding still get them.
  useEffect(() => {
    if (away) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        escape.current();
      } else if (event.key === 'Tab') {
        trapTab(event);
      }
      if ((event.target as Element | null)?.closest?.('input, textarea, select')) return;
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [away]);

  if (away) {
    return (
      <div className="onboarding-away island-bottom-centre" data-testid="onboarding-away">
        <Button
          variant="primary"
          icon={<ArrowLeft />}
          onClick={() => {
            if (signInWindow.current !== undefined) onSignedIn(signInWindow.current);
            signInWindow.current = undefined;
            setAway(false);
            setChecked((n) => n + 1);
          }}
        >
          Back to setup
        </Button>
      </div>
    );
  }

  if (simplified) {
    // Turned on mid-tour: the Simplified steps have no tour or Finish, so it shows the last one it has.
    const shown = (SIMPLIFIED_STEPS as readonly OnboardingStep[]).includes(step) ? step : 'connect';
    return (
      <div className="onboarding" data-testid="onboarding" data-onboarding-root>
        <div className="onboarding-backdrop" aria-hidden />
        {shown === 'welcome' && <CaptainWelcomeStep progress={<SetupProgress steps={steps} step="welcome" plain />} onSkip={() => onEnd('board')} onNext={next} />}
        {shown === 'connect' && (
          <ClaudeReadyStep
            key={checked}
            progress={<SetupProgress steps={steps} step="connect" plain />}
            onTerminal={runInShell}
            onOpenLink={onOpenLink}
            onBack={back}
            onSkip={() => onEnd('board')}
            onNext={() => onEnd('board')}
          />
        )}
      </div>
    );
  }

  if (step === 'tour') return <QuickTour progress={<SetupProgress step="tour" inline />} onBack={() => go('connect')} onDone={next} />;

  return (
    <div className="onboarding" data-testid="onboarding" data-onboarding-root>
      <div className="onboarding-backdrop" aria-hidden />
      {step === 'welcome' && <WelcomeStep progress={<SetupProgress step="welcome" />} onSkip={() => onEnd('board')} onNext={next} />}
      {step === 'connect' && (
        <ConnectStep
          key={checked}
          progress={<SetupProgress step="connect" />}
          onSignIn={runInShell}
          onOpenLink={onOpenLink}
          onLater={next}
          onNext={next}
        />
      )}
      {step === 'finish' && (
        <FinishStep
          progress={<SetupProgress step="finish" />}
          showInMenu={showInMenu}
          onShowInMenu={onShowInMenu}
          onBack={back}
          onEnd={onEnd}
        />
      )}
    </div>
  );
}

/**
 * "Step 2 of 4 · Connect", over a bar per step: the done ones lighter, the current one solid. `plain` leaves the
 * step's name out ("Step 1 of 2"), as the Simplified design's steps say it.
 */
function SetupProgress({ steps = ONBOARDING_STEPS, step, inline = false, plain = false }: { steps?: readonly OnboardingStep[]; step: OnboardingStep; inline?: boolean; plain?: boolean }) {
  const at = steps.indexOf(step);
  const label = `${inline ? 'Setup step' : 'Step'} ${at + 1} of ${steps.length}${plain ? '' : ` · ${STEP_LABELS[step]}`}`;
  return (
    <div className="onboarding-progress" data-inline={inline || undefined}>
      <span className="onboarding-progress-label">{label}</span>
      <div
        className="onboarding-progress-bars"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={at + 1}
      >
        {steps.map((each, index) => (
          <span key={each} className="onboarding-progress-bar" data-state={index < at ? 'done' : index === at ? 'current' : 'todo'} />
        ))}
      </div>
    </div>
  );
}

/** Keeps Tab and Shift-Tab cycling through onboarding's controls, never out to the board under it. */
function trapTab(event: KeyboardEvent) {
  const root = document.querySelector('[data-onboarding-root]');
  if (root === null) return;
  const controls = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (controls.length === 0) return;
  const at = controls.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : at === controls.length - 1 ? 0 : at + 1;
  event.preventDefault();
  controls[next]!.focus();
}
