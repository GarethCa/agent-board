import { CHAT_STYLE_LABELS, DEFAULT_CHAT_STYLE, setChatStyle, useChatStyle, type ChatStyle } from '../session/chat-style';
import { Choice, Choices, Fieldset, Tag } from '../ui';

const DETAILS: Record<ChatStyle, string> = {
  cards: 'Each call, permission, plan or limit a card in the stream, opening on a click, its actions on it.',
  timeline: 'A dot per event on a rail beside the messages, coloured by state. The live state pulses at the foot.',
  'status-line': 'The messages, finished calls as chips, and one live line over the message box.',
};

/** Settings › Agents › Chat: how every chat view shows an agent's states. The switch over a chat picks the same. */
export function ChatStyleSetting() {
  const style = useChatStyle();
  return (
    <>
      <Fieldset legend="Style">
        <Choices aria-label="Chat style">
          {(Object.keys(DETAILS) as ChatStyle[]).map((each) => (
            <Choice
              key={each}
              name="chat-style"
              label={
                each === DEFAULT_CHAT_STYLE ? (
                  <>
                    {CHAT_STYLE_LABELS[each]} <Tag tone="accent">default</Tag>
                  </>
                ) : (
                  CHAT_STYLE_LABELS[each]
                )
              }
              detail={DETAILS[each]}
              checked={style === each}
              onChange={() => setChatStyle(each)}
            />
          ))}
        </Choices>
      </Fieldset>
    </>
  );
}
