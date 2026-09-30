import { ZH_TW_CHAR_FIXES } from "./zhTwCharMap";

// AI 回覆的繁體中文把關（輸出端）。提示詞裡已經要求「只用台灣繁體中文」，但
// 正式站真的出現過模型混出簡體字「几倍」、日文漢字「同歩」；新接的 NVIDIA／
// Groq 模型（以中英文語料為主）混出簡體字的機率更高。這裡做兩件事：
//   1. 一對一、不會改錯的錯字直接替換成繁體（對照表見 zhTwCharMap.ts）。
//   2. 回覆裡出現成段日文假名（代表模型整段切到日文），視為不合格，讓呼叫端
//      改用下一家供應商，而不是把半日文的答案端給使用者。

/** 平假名＋片假名（不含中日共用的長音符號等標點）。 */
const KANA_PATTERN = /[ぁ-ゖァ-ヺ]/g;
/** 超過這個數量的假名才判定為「切到日文」；零星一兩個（例如引用日本公司名）放行。 */
const MAX_KANA = 3;

export interface ZhTwCheckResult {
  text: string;
  /** 替換掉的錯字數量（>0 時呼叫端會記 log，方便觀察哪家供應商常出錯）。 */
  fixedCount: number;
  /** 非 undefined 表示這份回覆不合格，內容是不合格原因。 */
  rejectReason?: string;
}

export function normalizeZhTw(text: string): ZhTwCheckResult {
  const kanaCount = text.match(KANA_PATTERN)?.length ?? 0;
  if (kanaCount > MAX_KANA) {
    return { text, fixedCount: 0, rejectReason: `回覆混入日文假名（${kanaCount} 字）` };
  }
  let fixedCount = 0;
  let out = "";
  for (const ch of text) {
    const fixed = ZH_TW_CHAR_FIXES.get(ch);
    if (fixed) {
      fixedCount++;
      out += fixed;
    } else {
      out += ch;
    }
  }
  return { text: out, fixedCount };
}
