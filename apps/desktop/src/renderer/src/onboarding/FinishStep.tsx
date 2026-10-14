import type { ReactNode } from 'react';
import { ArrowLeft, Eye, Map as MapIcon, SquareDashedMousePointer } from 'lucide-react';
import { Character } from '../board/Character';
import { Button, Checkbox } from '../ui';
import type { OnboardingEnd } from './first-run';

export interface FinishStepProps {
  progress: ReactNode;
  showInMenu: boolean;
  onShowInMenu(show: boolean): void;
  onBack(): void;
  onEnd(end: OnboardingEnd): void;
}

/** Onboarding's last step (mock AA): where to start, a first zone or the sample board, or just the board. */
export function FinishStep({ progress, showInMenu, onShowInMenu, onBack, onEnd }: FinishStepProps) {
  return (
    <section className="onboarding-card onboarding-finish" role="dialog" aria-modal="true" aria-labelledby="onboarding-finish-title">
      <header className="onboarding-finish-head">
        <span className="onboarding-finish-figure" aria-hidden>
          <Character harness="claude" pose="done" />
        </span>
        <div>
          <h1 id="onboarding-finish-title" className="onboarding-title">
            You&rsquo;re set up
          </h1>
          <p>Where do you want to start?</p>
        </div>
      </header>
      <div className="onboarding-choices">
        <button type="button" className="onboarding-choice" onClick={() => onEnd('zone')} autoFocus>
          <span className="onboarding-picture onboarding-choice-picture" aria-hidden>
            <ZonePicture />
          </span>
          <span className="onboarding-choice-body">
            <span className="onboarding-choice-title">
              <span className="onboarding-choice-icon" data-tone="accent">
                <SquareDashedMousePointer />
              </span>
              Create your first zone
            </span>
            <span className="onboarding-choice-text">
              Opens the Add zone menu. Point it at a repo or a folder, then start an agent inside.
            </span>
          </span>
        </button>
        <button type="button" className="onboarding-choice" onClick={() => onEnd('sample')}>
          <span className="onboarding-picture onboarding-choice-picture" aria-hidden>
            <SamplePicture />
          </span>
          <span className="onboarding-choice-body">
            <span className="onboarding-choice-title">
              <span className="onboarding-choice-icon">
                <MapIcon />
              </span>
              Explore a sample board
            </span>
            <span className="onboarding-choice-text">A demo board with agents in every state. Nothing runs and no tokens are spent.</span>
          </span>
        </button>
      </div>
      <div className="onboarding-again">
        <Checkbox
          checked={showInMenu}
          onChange={(event) => onShowInMenu(event.target.checked)}
          label={
            <>
              Show this again from <b>Help › Getting started</b> in the board menu
            </>
          }
        />
      </div>
      <footer className="onboarding-foot" data-shaded>
        {progress}
        <span className="onboarding-foot-gap" />
        <Button variant="ghost" size="lg" icon={<ArrowLeft />} onClick={onBack}>
          Back
        </Button>
        <Button size="lg" onClick={() => onEnd('board')}>
          Just show me the board
        </Button>
      </footer>
    </section>
  );
}

function ZonePicture() {
  return (
    <>
      <span className="pic-zone-outline" />
      <span className="pic-zone-tab">New zone</span>
      <span className="onboarding-mini pic-zone-menu">
        <span className="pic-zone-row" data-on>
          Repo…
        </span>
        <span className="pic-zone-row">Folder…</span>
        <span className="pic-zone-row">Group…</span>
      </span>
    </>
  );
}

function SamplePicture() {
  return (
    <>
      <span className="onboarding-mini-zone pic-sample-zone" />
      <span className="pic-sample-tab">sample-repo</span>
      <span className="onboarding-mini-zone pic-sample-zone-b" />
      <span className="onboarding-mini pic-sample-a">
        <span className="onboarding-mini-bar" />
        <span className="onboarding-mini-bar" />
        <span className="onboarding-mini-bar" />
      </span>
      <span className="onboarding-mini pic-sample-b" data-attention>
        <span className="onboarding-mini-bar" />
        <span className="onboarding-mini-bar" />
      </span>
      <span className="onboarding-mini pic-sample-c">
        <span className="onboarding-mini-bar" />
        <span className="onboarding-mini-bar" />
      </span>
      <span className="onboarding-perch pic-sample-perch-a">
        <Character harness="claude" pose="running" />
      </span>
      <span className="onboarding-perch pic-sample-perch-b">
        <Character harness="codex" pose="needs-permission" />
      </span>
      <span className="onboarding-perch pic-sample-perch-c">
        <Character harness="claude" pose="rate-limited" />
      </span>
      <span className="pic-sample-demo">
        <Eye />
        demo · no tokens
      </span>
    </>
  );
}
