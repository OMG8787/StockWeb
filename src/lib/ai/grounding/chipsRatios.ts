import type { ChipsRatios } from "@/lib/data";

/**
 * 把「籌碼比例」（融資使用率／外資持股比例／大戶持股比例＋前一期）組成給 AI 的
 * grounding 文字。原則同 buildStockGrounding 其他籌碼數字：每個數字都帶明確角色
 * 標籤（本期/前一期/增減），增減幅度在這裡算好寫死，不讓模型自己拿兩個百分比相減
 * 或把股數換算成張（見 RULE_SHARES_NOT_LOTS、RULE_CHIPS_RATIOS）。
 */

// export：今日建議／今日快報的精簡版（ai/chipsRatiosWording.ts）共用同一套升降措辭。
export function pointDelta(current: number, prev: number, period: string): string {
  const diff = Math.round((current - prev) * 100) / 100;
  if (diff === 0) return `與${period}持平`;
  return `較${period}${diff > 0 ? "上升" : "下降"} ${Math.abs(diff).toFixed(2)} 個百分點`;
}

function lotsText(shares: number): string {
  return `約 ${Math.round(shares / 1000).toLocaleString("en-US")} 張`;
}

export function describeChipsRatios(r: ChipsRatios | null): string | undefined {
  if (!r) return undefined;
  const lines: string[] = [];

  if (r.margin) {
    const m = r.margin;
    const cmp =
      m.prevUtilizationPercent != null
        ? `，前一交易日 ${m.prevUtilizationPercent.toFixed(2)}%，${pointDelta(m.utilizationPercent, m.prevUtilizationPercent, "前一交易日")}`
        : "（前一交易日資料查不到，無法比較）";
    const bal =
      m.balanceChange != null
        ? `；融資餘額 ${m.balance.toLocaleString("en-US")} 張，較前一交易日${m.balanceChange >= 0 ? "增加" : "減少"} ${Math.abs(m.balanceChange).toLocaleString("en-US")} 張`
        : `；融資餘額 ${m.balance.toLocaleString("en-US")} 張`;
    lines.push(`- 融資使用率（${m.date ?? "最近交易日"}）：${m.utilizationPercent.toFixed(2)}%${cmp}${bal}`);
  } else {
    lines.push("- 融資使用率：資料暫缺");
  }

  if (r.foreign) {
    const f = r.foreign;
    const cmp =
      f.prevHoldingPercent != null && f.prevDate
        ? `，前一交易日（${f.prevDate}）${f.prevHoldingPercent.toFixed(2)}%，${pointDelta(f.holdingPercent, f.prevHoldingPercent, "前一交易日")}`
        : "（前一交易日資料查不到，無法比較）";
    lines.push(`- 外資持股比例（${f.date}）：${f.holdingPercent.toFixed(2)}%（外資持股${lotsText(f.heldShares)}）${cmp}`);
  } else {
    lines.push("- 外資持股比例：資料暫缺");
  }

  if (r.majorHolders) {
    const h = r.majorHolders;
    const cmp =
      h.prevHoldingPercent != null && h.prevDate
        ? `；上一週（${h.prevDate}）${h.prevHoldingPercent.toFixed(2)}%${h.prevHolders != null ? `、${h.prevHolders} 人` : ""}，${pointDelta(h.holdingPercent, h.prevHoldingPercent, "上一週")}${
            h.prevHolders != null && h.prevHolders !== h.holders
              ? `，大戶人數${h.holders > h.prevHolders ? "增加" : "減少"} ${Math.abs(h.holders - h.prevHolders)} 人`
              : ""
          }`
        : "；上一週資料本站還在累積中，無法比較";
    lines.push(
      `- 大戶持股比例（持股1000張以上的股東，集保「週資料」，資料日期 ${h.date}）：${h.holdingPercent.toFixed(2)}%，${h.holders} 人、合計持有${lotsText(h.shares)}${cmp}`
    );
  } else {
    lines.push("- 大戶持股比例：資料暫缺");
  }

  return `籌碼比例（升降幅度已算好，直接引用，不要自己重算）：\n${lines.join("\n")}`;
}
