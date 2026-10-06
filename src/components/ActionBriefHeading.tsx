"use client";

import { useSyncExternalStore } from "react";
import { getTradingStance, type TradingStance } from "@/lib/ai/tradingStance";

// 每分鐘重新判斷一次時段。用 useSyncExternalStore：伺服器（靜態預先產生）一律用「今日建議」，
// 瀏覽器端用使用者當下時間，避免 hydration 不一致。
function subscribe(onChange: () => void): () => void {
  const id = setInterval(onChange, 60_000);
  return () => clearInterval(id);
}
const clientSnapshot = () => {
  const s = getTradingStance();
  return `${s.briefMode}|${s.briefTitle}|${s.nextOpenLabel}`;
};
const serverSnapshot = () => "today|今日建議|";

/** 目前時段對應的今日建議／明日操作建議模式（client component 用）。 */
export function useBriefStance(): Pick<TradingStance, "briefMode" | "briefTitle" | "nextOpenLabel"> {
  const [mode, title, nextOpenLabel] = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot).split("|");
  return { briefMode: mode as TradingStance["briefMode"], briefTitle: title, nextOpenLabel };
}

/**
 * /action 頁首：14:30 後到隔天開盤前（含週末）標題改成「明日操作建議」／「下個交易日操作建議」，
 * 跟卡片內容（api/action-brief 依同一個 getTradingStance 產生）一致。
 */
export default function ActionBriefHeading() {
  const stance = useBriefStance();
  const nextOpen = stance.briefMode === "next-open";
  return (
    <div>
      <h1 className="text-xl font-semibold">{stance.briefTitle}</h1>
      <p className="mt-1 text-sm text-(--text-secondary)">
        {nextOpen
          ? `台股已收盤，這裡用最新收盤後的資料，直接講 ${stance.nextOpenLabel} 整個交易時段（開盤與盤中）可以買哪幾檔、怎麼操作（開盤跳空太高就不追、盤中回到區間再分批買、買進後跌破多少出場）。`
          : "不需要懂股票也看得懂：直接講今天可以買哪幾檔股票、為什麼。"}
        每一檔都先用技術面、籌碼面（法人買賣超）、持股結構面（大戶／外資持股比例、融資使用率）、基本面（本益比、殖利率）、財報面（營收成長）五個面向體檢，至少兩個面向支持、最多一個面向不支持，再對照價位算出「本站綜合評等」，結論只有「建議買進」或「先不要買」兩種：建議買進的現價就可分批買，另附一個拉回時可加碼的參考價；先不要買的不給買進區間，只說什麼條件出現才會改判。這裡最多列 5 檔建議買進，另列一檔「先不要買／不建議追」；跟個股頁「問AI」用的是同一份評等。真的沒有夠格的標的時會直接說觀望，不會硬湊。技術面不支持（空方訊號多於多方）的一律不列入。本站評等的回測未顯示穩定超越大盤；長期持有大盤 ETF（如 0050）本身是很強的對照。
      </p>
    </div>
  );
}
