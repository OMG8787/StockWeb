import type { ChipsRatios } from "@/lib/data";
import { pointDelta } from "./grounding/chipsRatios";

/**
 * 「持股結構」四項（大戶持股比例／外資持股比例／融資使用率／券資比）在今日建議、今日快報
 * 共用的精簡文字與白話解釋；名詞白話（GLOSS_*）全站共用（個股問答、列表表頭也用這裡）。
 *
 * 個股問答用的是 grounding/chipsRatios.ts 的 describeChipsRatios()（較完整、多行），
 * 這裡是給「一次列很多檔」的體檢表／快報用的單行精簡版——刻意不合併：兩者的詳細程度
 * 是配合各自的 prompt 長度預算刻意分開的。但升降幅度的措辭（pointDelta）與三個名詞的
 * 白話解釋要跟個股問答一致（措辭規則見 askSystemPrompt.ts 的 RULE_CHIPS_RATIOS），
 * 不另外發明新說法。
 */

// 三個名詞的白話解釋。意思跟 askSystemPrompt.ts 的 RULE_CHIPS_RATIOS 一致，但刻意寫得
// 更短（括號內 ≤15 字）：今日建議／今日快報 2026-10-04 改成精簡格式，術語解釋只能用
// 短括號帶過；個股問答篇幅較寬，維持那邊的完整說法，兩者刻意不合併。
export const GLOSS_MARGIN_UTILIZATION = "融資使用率（散戶借錢買股的程度）";
export const GLOSS_FOREIGN_HOLDING = "外資持股比例（外資持有股數占比）";
export const GLOSS_MAJOR_HOLDERS = "大戶（持股1000張以上股東）";
export const GLOSS_SHORT_MARGIN_RATIO = "券資比（放空張數相對融資的比例）";
/** 列表表頭／個股頁的滑鼠提示：比上面的括號版多講公式、怎麼解讀與期別。 */
export const GLOSS_SHORT_MARGIN_RATIO_TITLE =
  "券資比＝融券餘額 ÷ 融資餘額（放空張數相對融資的比例，收盤後資料）。偏高代表空單相對多，股價上漲時空單被迫回補可能引發軋空；但也代表看空的人多，方向要配合其他資料判斷。下方▲▼為較前一交易日增減的百分點；沒有融資餘額（例如興櫃）時無法計算，顯示「—」。";

/** 券資比的解讀限制（方向不明確），今日建議／今日快報／個股問答共用。 */
export const RULE_SHORT_MARGIN_RATIO_MEANING =
  "券資比升高＝空單相對融資變多：可能代表看空的人增加，也可能成為日後空單回補（軋空）的買盤燃料，方向不明確——不可單獨當成利多或利空，只能搭配股價走勢、法人買賣等其他資料一起說明。";
/** 三項資料的共通誠實規則：週資料、照抄升降幅度、查不到就照實說。今日建議／今日快報的提示詞都會引用。 */
export const RULE_HOLDING_STRUCTURE_WORDING =
  "大戶持股是集保『週資料』：每次提到都必須標資料週別（例如『09/24那週』）、比較要說『較上一週』，不可說成『今天／較昨天』；外資持股比例、融資使用率、券資比是每日資料，比『前一交易日』。升降幅度照抄參考資料，不自己相減；寫『查無資料』『無法比較』就照實說。這幾項只有台股有，美股沒有是資料源限制、不是抓取失敗。";

function majorText(r: ChipsRatios): string {
  const h = r.majorHolders;
  if (!h) return "大戶持股：查無資料";
  const cmp =
    h.prevHoldingPercent != null && h.prevDate
      ? `，上一週（${h.prevDate}）${h.prevHoldingPercent.toFixed(2)}%，${pointDelta(h.holdingPercent, h.prevHoldingPercent, "上一週")}`
      : "，上一週資料本站還在累積中，無法比較";
  return `大戶持股（千張以上大戶，集保週資料，${h.date}那週）${h.holdingPercent.toFixed(2)}%${cmp}`;
}

function foreignText(r: ChipsRatios): string {
  const f = r.foreign;
  if (!f) return "外資持股：查無資料";
  const cmp =
    f.prevHoldingPercent != null
      ? `，${pointDelta(f.holdingPercent, f.prevHoldingPercent, "前一交易日")}（前一交易日${f.prevHoldingPercent.toFixed(2)}%）`
      : "，前一交易日資料查不到，無法比較";
  return `外資持股比例（${f.date}）${f.holdingPercent.toFixed(2)}%${cmp}`;
}

function marginText(r: ChipsRatios): string {
  const m = r.margin;
  if (!m) return "融資使用率：查無資料";
  const cmp =
    m.prevUtilizationPercent != null
      ? `，${pointDelta(m.utilizationPercent, m.prevUtilizationPercent, "前一交易日")}（前一交易日${m.prevUtilizationPercent.toFixed(2)}%）`
      : "，前一交易日資料查不到，無法比較";
  return `融資使用率（${m.date ?? "最近交易日"}）${m.utilizationPercent.toFixed(2)}%${cmp}`;
}

function shortText(r: ChipsRatios): string {
  const t = r.short;
  if (!t) return "券資比：查無資料";
  const cmp =
    t.prevShortMarginRatioPercent != null
      ? `，${pointDelta(t.shortMarginRatioPercent, t.prevShortMarginRatioPercent, "前一交易日")}（前一交易日${t.prevShortMarginRatioPercent.toFixed(2)}%）`
      : "，前一交易日資料查不到，無法比較";
  return `券資比（${t.date ?? "最近交易日"}）${t.shortMarginRatioPercent.toFixed(2)}%${cmp}`;
}

/**
 * 今日快報用的最精簡單行（一次列十幾檔，要省 AI 輸入長度）：期別說明放在區塊標題裡講一次，
 * 每檔只留本期數字＋升降幅度；大戶仍保留週別日期，避免被講成每日資料。四項都沒有回 null。
 */
export function holdingStructureCompact(r: ChipsRatios | null): string | null {
  if (!r) return null;
  const parts: string[] = [];
  const h = r.majorHolders;
  if (h) {
    const cmp = h.prevHoldingPercent != null ? pointDelta(h.holdingPercent, h.prevHoldingPercent, "上一週") : "上一週無法比較";
    parts.push(`大戶持股${h.holdingPercent.toFixed(2)}%（週資料，${h.date}那週，${cmp}）`);
  }
  const f = r.foreign;
  if (f) {
    const cmp = f.prevHoldingPercent != null ? pointDelta(f.holdingPercent, f.prevHoldingPercent, "前一交易日") : "前一交易日無法比較";
    parts.push(`外資持股${f.holdingPercent.toFixed(2)}%（${cmp}）`);
  }
  const m = r.margin;
  if (m) {
    const cmp =
      m.prevUtilizationPercent != null ? pointDelta(m.utilizationPercent, m.prevUtilizationPercent, "前一交易日") : "前一交易日無法比較";
    parts.push(`融資使用率${m.utilizationPercent.toFixed(2)}%（${cmp}）`);
  }
  const t = r.short;
  if (t) {
    const cmp =
      t.prevShortMarginRatioPercent != null
        ? pointDelta(t.shortMarginRatioPercent, t.prevShortMarginRatioPercent, "前一交易日")
        : "前一交易日無法比較";
    parts.push(`券資比${t.shortMarginRatioPercent.toFixed(2)}%（${cmp}）`);
  }
  return parts.length > 0 ? parts.join("、") : null;
}

/** 四項各自的單行文字（順序固定：大戶→外資→融資→融券）。r 為 null 時回 null，由呼叫端決定怎麼寫「無資料」。 */
export function holdingStructureParts(
  r: ChipsRatios | null
): { major: string; foreign: string; margin: string; short: string } | null {
  if (!r) return null;
  return { major: majorText(r), foreign: foreignText(r), margin: marginText(r), short: shortText(r) };
}
