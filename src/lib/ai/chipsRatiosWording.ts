import type { ChipsRatios } from "@/lib/data";
import { pointDelta } from "./grounding/chipsRatios";

/**
 * 「持股結構」三項（大戶持股比例／外資持股比例／融資使用率）在今日建議、今日快報
 * 共用的精簡文字與白話解釋。
 *
 * 個股問答用的是 grounding/chipsRatios.ts 的 describeChipsRatios()（較完整、多行），
 * 這裡是給「一次列很多檔」的體檢表／快報用的單行精簡版——刻意不合併：兩者的詳細程度
 * 是配合各自的 prompt 長度預算刻意分開的。但升降幅度的措辭（pointDelta）與三個名詞的
 * 白話解釋要跟個股問答一致（措辭規則見 askSystemPrompt.ts 的 RULE_CHIPS_RATIOS），
 * 不另外發明新說法。
 */

// 三個名詞的白話解釋，文字跟 RULE_CHIPS_RATIOS 裡的一致（那個檔案不歸這裡管，
// 所以在這裡另存具名常數給今日建議／今日快報的提示詞引用）。
export const GLOSS_MARGIN_UTILIZATION = "融資使用率（融資餘額占可融資上限的比例，越高代表散戶借錢買股的程度越高）";
export const GLOSS_FOREIGN_HOLDING = "外資持股比例（外國機構投資人持有的股數占公司總股數的比例）";
export const GLOSS_MAJOR_HOLDERS = "大戶（持有1000張以上的股東）";

/** 三項資料的共通誠實規則：週資料、照抄升降幅度、查不到就照實說。今日建議／今日快報的提示詞都會引用。 */
export const RULE_HOLDING_STRUCTURE_WORDING =
  "大戶持股比例是集保每週公布一次的『週資料』，只要提到就要明講「這是集保每週公布一次的週資料」並講出資料那週的日期（例如『09/24那週』），跟上一週比要講『較上一週』，絕對不能講成『較昨天』『今天大戶加碼』這種每日說法；外資持股比例與融資使用率才是每日資料，比較對象是『前一交易日』。升降幅度參考資料已經算好（例如『較前一交易日上升 0.81 個百分點』），直接照抄，不要自己拿兩個百分比相減重算；資料寫『查無資料』『無法比較』就照實說，不要自己猜升降。這三項只有台股有公開資料，美股沒有這類公開資料是資料源限制、不是抓取失敗。";

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

/**
 * 今日快報用的最精簡單行（一次列十幾檔，要省 AI 輸入長度）：期別說明放在區塊標題裡講一次，
 * 每檔只留本期數字＋升降幅度；大戶仍保留週別日期，避免被講成每日資料。三項都沒有回 null。
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
  return parts.length > 0 ? parts.join("、") : null;
}

/** 三項各自的單行文字（順序固定：大戶→外資→融資）。r 為 null 時回 null，由呼叫端決定怎麼寫「無資料」。 */
export function holdingStructureParts(r: ChipsRatios | null): { major: string; foreign: string; margin: string } | null {
  if (!r) return null;
  return { major: majorText(r), foreign: foreignText(r), margin: marginText(r) };
}
