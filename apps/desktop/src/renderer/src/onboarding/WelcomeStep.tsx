import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { APP_NAME } from '../../../shared/brand';
import { Character } from '../board/Character';
import { BrandMark } from '../chrome/BrandMark';
import { Button } from '../ui';

/** Onboarding's first step (mock X): what agent-board is, in one screen. */
export function WelcomeStep({ progress, onSkip, onNext }: { progress: ReactNode; onSkip(): void; onNext(): void }) {
  return (
    <section className="onboarding-card onboarding-welcome" role="dialog" aria-modal="true" aria-labelledby="onboarding-welcome-title">
      <div className="onboarding-welcome-head">
        <BrandMark className="onboarding-logo" />
        <h1 id="onboarding-welcome-title" className="onboarding-hero">
          Welcome to {APP_NAME}
        </h1>
        <p className="onboarding-lead">
          All your Claude Code and Codex sessions on one board, so you can see what each agent is doing and who needs you.
        </p>
      </div>
      <div className="onboarding-points">
        <Point title="A board of agents" picture={<BoardPicture />}>
          Each session is a tile in its project&rsquo;s zone. Subagents perch on top while they work.
        </Point>
        <Point title="A needs-you inbox" picture={<InboxPicture />}>
          Questions and permission prompts from every agent land in one place. Answer without hunting.
        </Point>
        <Point title="Flows between agents" picture={<FlowPicture />}>
          Wire one agent&rsquo;s output into the next. A planner hands <code>plan.md</code> to a builder, then a reviewer.
        </Point>
      </div>
      <footer className="onboarding-foot">
        {progress}
        <span className="onboarding-foot-note">About 2 min · Help › Getting started reopens it</span>
        <span className="onboarding-foot-gap" />
        <Button variant="ghost" size="lg" onClick={onSkip}>
          Skip
        </Button>
        <Button variant="primary" size="lg" trailingIcon={<ArrowRight />} onClick={onNext} autoFocus>
          Get started
        </Button>
      </footer>
    </section>
  );
}

function Point({ title, picture, children }: { title: string; picture: ReactNode; children: ReactNode }) {
  return (
    <div className="onboarding-point">
      <div className="onboarding-picture" aria-hidden>
        {picture}
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/** A mini tile: a few grey bars, standing for a session. */
function MiniTile({ className, lines = 2 }: { className: string; lines?: number }) {
  return (
    <div className={`onboarding-mini ${className}`}>
      {Array.from({ length: lines + 1 }, (_, index) => (
        <span key={index} className="onboarding-mini-bar" />
      ))}
    </div>
  );
}

function BoardPicture() {
  return (
    <>
      <div className="onboarding-mini-zone" />
      <MiniTile className="pic-board-a" lines={2} />
      <MiniTile className="pic-board-b" lines={1} />
      <span className="onboarding-perch pic-board-perch">
        <Character harness="claude" pose="running" />
        <Character harness="codex" pose="thinking" />
      </span>
      <span className="onboarding-perch pic-board-perch-b">
        <Character harness="claude" pose="idle" />
      </span>
    </>
  );
}

function InboxPicture() {
  return (
    <>
      <span className="onboarding-mini-pill">
        <span className="onboarding-mini-dot" />2 need you
      </span>
      <div className="onboarding-mini pic-inbox-tile" data-attention>
        <span className="onboarding-mini-bar" />
        <span className="onboarding-mini-ask" />
      </div>
      <span className="onboarding-perch pic-inbox-perch">
        <Character harness="claude" pose="waiting" />
      </span>
    </>
  );
}

function FlowPicture() {
  return (
    <>
      <MiniTile className="pic-flow-a" lines={1} />
      <MiniTile className="pic-flow-b" lines={1} />
      <svg className="onboarding-flow" viewBox="0 0 216 128">
        <path d="M80 44 C 110 44, 104 86, 134 86" />
        <rect className="onboarding-flow-port" x="76" y="39" width="9" height="9" rx="2" />
        <rect className="onboarding-flow-port" data-end x="130" y="81.5" width="9" height="9" rx="2" />
      </svg>
      <code className="onboarding-flow-payload">plan.md</code>
      <span className="onboarding-perch pic-flow-perch">
        <Character harness="claude" pose="handing-off" />
      </span>
    </>
  );
}
