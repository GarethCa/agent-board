import { Fieldset, Hint, Switch } from '../ui';
import { useSimplified } from '../design';
import { UsageDetail, useUsage } from './UsagePill';
import { useUsageOnBoard } from './usage-on-board';
import { usageMeter } from './usage-view';

/** Settings › Usage › Plan usage: the 5-hour and weekly figures the pill shows, and the switch for showing it on the board. */
export function UsagePlanSetting() {
  const { reading, now } = useUsage();
  const [usageOnBoard, setUsageOnBoard] = useUsageOnBoard();
  const simplified = useSimplified();
  const meter = reading === undefined ? undefined : usageMeter(reading, now);
  return (
    <>
      <Fieldset legend="Used so far">
        {meter === undefined || meter.windows.length === 0 ? <Hint>No reading yet: it comes from a Claude agent&apos;s status line.</Hint> : <UsageDetail meter={meter} />}
      </Fieldset>
      <Switch label="Show usage on the board" checked={usageOnBoard} onChange={(event) => setUsageOnBoard(event.target.checked)} />
      <Hint>{usageOnBoard ? 'On' : 'Off'} · shows the figures {simplified ? 'in the toolbar, before Needs you' : 'beside the zoom controls, bottom right'}</Hint>
    </>
  );
}
