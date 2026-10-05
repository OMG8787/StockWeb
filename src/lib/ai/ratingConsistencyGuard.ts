/**
 * 回答後的「評等與價位建議一致性」檢查（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 正式站：評等為「建議先不要買」，AI 仍自己補「若買進後跌破 134.5 元建議出場」（134.5 是觀察用支撐），
 * 或寫「等回到 A～B 再分批買」——跟「先不要買」矛盾。numberGuard 只管數字抄錯，抓不到這種「不該出現的價位建議」。
 * 規則：參考資料裡某檔是「建議先不要買」且使用者沒持有（該檔沒有【持有中出場參考】）時，回答裡歸屬於那檔的
 * 「出場價／停損價／買進區間／回到 X 再買」子句一律刪掉（只能講改判建議買進的條件，見 describeSiteRating）。
 *
 * 選擇「刪掉子句」而不是重生：同 numberGuard 的理由（零花費、確定性、重生仍可能再犯）。
 */

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const RATING_LINE = /【本站綜合評等】([^()（）\n【】]+?)\(([0-9A-Za-z.\-]+)\)：未持有：「([^」]*)」/g;
/** 使用者持有這檔時，參考資料會附這個標題（持有中出場價是合理的）。 */
export const HOLDING_EXIT_MARKER = "持有中出場參考";

/** 「先不要買」時不可出現的價位建議（出場、停損、買進區間、回到 X 再買）。 */
export const AVOID_FORBIDDEN_PRICE_ADVICE = new RegExp(
  [
    String.raw`跌破\s*(?:${NUM})[^，,。；;\n]{0,10}(?:出場|停損|賣出)`,
    String.raw`(?:停損|出場)(?:價|點|參考價)?\s*(?:設|在|為|於|：|:)?\s*(?:約)?\s*(?:${NUM})`,
    String.raw`(?:回到|回檔到|拉回到|拉回至|回測)\s*(?:約)?\s*(?:${NUM})(?:\s*[～~至到\-]\s*(?:${NUM}))?[^，,。；;\n]{0,10}(?:買|進場|布局|承接)`,
    String.raw`(?:買進區間|分批買進區間|進場區間|買點)\s*(?:約|為|在|：|:)?\s*(?:${NUM})`,
  ].join("|")
);

interface Anchor {
  symbol: string;
  name: string;
  avoid: boolean;
  held: boolean;
}

function parseAnchors(grounding: string): Anchor[] {
  const raw = [...grounding.matchAll(RATING_LINE)];
  return raw.map((m, i) => {
    const seg = grounding.slice(m.index ?? 0, raw[i + 1]?.index ?? grounding.length);
    return {
      symbol: m[2].toUpperCase(),
      name: m[1].trim(),
      avoid: m[3].startsWith("建議先不要買"),
      held: seg.includes(HOLDING_EXIT_MARKER),
    };
  });
}

function stockBefore(text: string, anchors: Anchor[]): Anchor | null {
  let best = -1;
  let hit: Anchor | null = null;
  for (const a of anchors) {
    for (const key of [a.symbol, a.name]) {
      if (key.length < 2) continue;
      const i = text.lastIndexOf(key);
      if (i > best) {
        best = i;
        hit = a;
      }
    }
  }
  if (hit) return hit;
  // 單一檔的問答常常不重複寫名稱：參考資料只有一檔時就是那檔。
  const unique = new Set(anchors.map((a) => a.symbol));
  return unique.size === 1 ? anchors[0] : null;
}

export interface AvoidAdviceFix {
  symbol: string;
  removed: string;
}

/** 刪掉「先不要買」股票的出場價／買進區間子句。參考資料沒有先不要買的檔就原樣回傳。 */
export function guardAvoidPriceAdvice(answer: string, grounding: string): { text: string; fixes: AvoidAdviceFix[] } {
  const anchors = parseAnchors(grounding);
  if (!answer || !anchors.some((a) => a.avoid && !a.held)) return { text: answer, fixes: [] };
  const fixes: AvoidAdviceFix[] = [];
  const out: string[] = [];
  let consumed = "";
  for (const line of answer.split("\n")) {
    const clauses = line.split(/(?<=[，,。；;！？])/);
    const kept: string[] = [];
    let lineSoFar = "";
    for (const c of clauses) {
      lineSoFar += c;
      if (AVOID_FORBIDDEN_PRICE_ADVICE.test(c)) {
        const who = stockBefore(consumed + lineSoFar, anchors);
        if (who && who.avoid && !who.held) {
          fixes.push({ symbol: who.symbol, removed: c });
          continue;
        }
      }
      kept.push(c);
    }
    consumed += line + "\n";
    if (kept.length < clauses.length) {
      let fixed = kept.join("").replace(/[，,]\s*$/, "。");
      if (/^\s*(?:[-•*]|\d+[.、])?\s*$/.test(fixed)) continue;
      // 被刪的是句尾、留下的句子沒有句號時補一個。
      if (!/[。！？：:）)]\s*$/.test(fixed) && /[。；;]\s*$/.test(line)) fixed += "。";
      out.push(fixed);
    } else {
      out.push(line);
    }
  }
  return { text: out.join("\n"), fixes };
}
