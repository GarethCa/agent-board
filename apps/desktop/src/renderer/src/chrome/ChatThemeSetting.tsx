import { CHAT_THEME_DETAILS, CHAT_THEME_LABELS, CHAT_THEMES, DEFAULT_CHAT_THEME, setChatTheme, useChatTheme } from '../session/chat-theme';
import { Choice, Choices, Fieldset, Tag } from '../ui';

/** Settings › Agents › Chat: whether an agent's chat view is dark or light. Terminals stay dark; the Captain's chat follows the app. */
export function ChatThemeSetting() {
  const theme = useChatTheme();
  return (
    <Fieldset legend="Chat colours">
      <Choices aria-label="Chat colours">
        {CHAT_THEMES.map((each) => (
          <Choice
            key={each}
            name="chat-theme"
            label={
              each === DEFAULT_CHAT_THEME ? (
                <>
                  {CHAT_THEME_LABELS[each]} <Tag tone="accent">default</Tag>
                </>
              ) : (
                CHAT_THEME_LABELS[each]
              )
            }
            detail={CHAT_THEME_DETAILS[each]}
            checked={theme === each}
            onChange={() => setChatTheme(each)}
          />
        ))}
      </Choices>
    </Fieldset>
  );
}
