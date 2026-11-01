import { CONVERSATION_AS, CONVERSATION_AS_LABELS, setConversationAs, useConversationAs } from '../session/conversation-as';
import { Fieldset, Hint, Segmented } from '../ui';

/** Under the Simplified design: how an agent's conversation is shown, until that agent has a view picked. */
export function ConversationAsSetting() {
  return (
    <Fieldset legend="Show the conversation as">
      <Segmented
        aria-label="Show the conversation as"
        options={CONVERSATION_AS.map((id) => ({ id, label: CONVERSATION_AS_LABELS[id] }))}
        value={useConversationAs()}
        onChange={setConversationAs}
      />
      <Hint>Terminal style is the timeline Claude Code itself shows. Agent windows set to open on Chat open on the Timeline instead.</Hint>
    </Fieldset>
  );
}
