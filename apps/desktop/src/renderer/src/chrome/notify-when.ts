import type { NeedsYouShows } from '@agent-board/daemon/protocol';

/** The "Notify me when" pop-up's choices, which is what Needs you lists (`needsYouShows`): notifications follow it. */
export const NOTIFY_WHEN: readonly { value: NeedsYouShows; label: string }[] = [
  { value: 'explicit', label: 'Something needs me' },
  { value: 'turns', label: 'Something needs me or finishes' },
];

/** The setting a pop-up value stands for; an unknown one is the default. */
export function needsYouShowsFrom(value: string): NeedsYouShows {
  return NOTIFY_WHEN.find((choice) => choice.value === value)?.value ?? 'explicit';
}

/** Whether "Also while agent-board is in front" is drawn: only with technical details shown. */
export const showsInFrontSwitch = (technical: boolean): boolean => technical;
