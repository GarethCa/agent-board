import { useSimplified } from '../design';
import { useTechnicalDetails } from '../technical';
import { Fieldset, Hint, Switch } from '../ui';
import { StatusLookSetting } from './StatusLookSetting';

type OnError = (action: string) => (error: unknown) => void;

/**
 * The "Simplified design" setting: Classic, today's design, unless it is turned on. Every window switches at once.
 * Under it, Show technical details adds the technical layer back (also in View › Show Technical Details), and each
 * agent's status is shown as icons and words or as characters.
 */
export function SimplifiedDesignSetting({ onError }: { onError: OnError }) {
  const simplified = useSimplified();
  // `useTechnicalDetails()` is true under Classic, which has no switch: the switch is on only under the Simplified design.
  const shown = useTechnicalDetails();
  const technical = simplified && shown;
  const change = (on: boolean) => void window.agentBoard.design.set(on ? 'simplified' : 'classic').catch(onError('change the design'));
  const changeTechnical = (on: boolean) => void window.agentBoard.technical.set(on).catch(onError('change Show technical details'));
  return (
    <Fieldset legend="Simplified design · Preview">
      <Switch label="Use the Simplified design" checked={simplified} onChange={(event) => change(event.target.checked)} />
      <Hint>A calmer, native look, still being built: parts of the app look as they do now until theirs is done. Theme packs wait while it is on.</Hint>
      {simplified && (
        <>
          <Switch label="Show technical details" checked={technical} onChange={(event) => changeTechnical(event.target.checked)} />
          <Hint>Adds branches, models, pull requests, raw states, terminals and drawing tools back, without moving anything else.</Hint>
          <StatusLookSetting />
        </>
      )}
    </Fieldset>
  );
}
