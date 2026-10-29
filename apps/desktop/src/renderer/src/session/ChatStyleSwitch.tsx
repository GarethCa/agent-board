import { GitCommitVertical, LayoutList, PanelBottom, type LucideIcon } from 'lucide-react';
import { ToolButton, Tooltip } from '../ui';
import { CHAT_STYLE_LABELS, CHAT_STYLES, setChatStyle, useChatStyle, type ChatStyle } from './chat-style';

const ICONS: Record<ChatStyle, LucideIcon> = { cards: LayoutList, timeline: GitCommitVertical, 'status-line': PanelBottom };

/** The quick switch over a chat between its styles, an icon each: the same choice as Settings › Chat, for every chat. */
export function ChatStyleSwitch() {
  const style = useChatStyle();
  return (
    <span className="chat-style-switch" role="group" aria-label="Chat style">
      {CHAT_STYLES.map((each) => {
        const Icon = ICONS[each];
        return (
          <Tooltip key={each} content={`${CHAT_STYLE_LABELS[each]}: for every chat`}>
            <button type="button" aria-label={CHAT_STYLE_LABELS[each]} aria-pressed={each === style} onClick={() => setChatStyle(each)}>
              <Icon aria-hidden />
            </button>
          </Tooltip>
        );
      })}
    </span>
  );
}

/**
 * The same choice as one button, for a header short of room (the Captain's panel): its icon the style now, a click
 * the next.
 */
export function ChatStyleButton() {
  const style = useChatStyle();
  const next = CHAT_STYLES[(CHAT_STYLES.indexOf(style) + 1) % CHAT_STYLES.length]!;
  const Icon = ICONS[style];
  return (
    <ToolButton
      size="sm"
      icon={<Icon />}
      label={`Chat style: ${CHAT_STYLE_LABELS[style]}`}
      hint={`Chat style: ${CHAT_STYLE_LABELS[style]}. Click for ${CHAT_STYLE_LABELS[next]}, in every chat`}
      onClick={() => setChatStyle(next)}
    />
  );
}
