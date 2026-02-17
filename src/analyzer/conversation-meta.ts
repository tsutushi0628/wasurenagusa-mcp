export interface ParsedMessage {
  role: string;
  text: string;
}

export interface ConversationMeta {
  avgUserMessageLength: number;      // 直近5ターンのユーザー平均文字数
  currentMessageLength: number;       // 最新ユーザーメッセージの文字数
  turnsSinceLastPositive: number;     // 最後にポジティブな反応からの経過ターン数
}

const POSITIVE_PATTERNS = /ありがとう|いいね|よさそう|完璧|おけ|ok|good|great|nice|👍|🎉|素晴らしい|助かる/i;

export function computeConversationMeta(messages: ParsedMessage[]): ConversationMeta {
  const userMessages = messages.filter(m => m.role === "user");

  if (userMessages.length === 0) {
    return { avgUserMessageLength: 0, currentMessageLength: 0, turnsSinceLastPositive: 0 };
  }

  const current = userMessages[userMessages.length - 1];
  const currentLength = current.text.length;

  // 直近5件のユーザーメッセージで平均を計算
  const recent = userMessages.slice(-5);
  const avgLength = recent.reduce((sum, m) => sum + m.text.length, 0) / recent.length;

  // 最後のポジティブ反応からの経過ターン数
  let turnsSincePositive = 0;
  for (let i = userMessages.length - 1; i >= 0; i--) {
    if (POSITIVE_PATTERNS.test(userMessages[i].text)) {
      break;
    }
    turnsSincePositive++;
  }

  return {
    avgUserMessageLength: Math.round(avgLength),
    currentMessageLength: currentLength,
    turnsSinceLastPositive: turnsSincePositive,
  };
}
