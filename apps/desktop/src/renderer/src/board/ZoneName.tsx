import { Truncate } from '../ui';

/** A zone's name in a dialog's title: one line, in the accent, cut with an ellipsis when long and whole on hover. */
export function ZoneName({ name }: { name: string }) {
  return <Truncate text={name} className="new-agent-zone" />;
}
