import { fetchWithTimeout } from "./cache";

export interface MarketDepth {
  /** 內盤成交量（張）——以買方掛單（較低的）價格成交，代表賣方主動降價
   *  出脫，傳統上視為偏空方力道（賣壓）的指標。（先前版本把這個欄位的
   *  說明跟 outMarketLots 寫反了，使用者指出後已修正。） */
  inMarketLots: number;
  /** 外盤成交量（張）——以賣方掛單（較高的）價格成交，代表買方主動追價
   *  買進，傳統上視為偏多方力道（買氣）的指標。 */
  outMarketLots: number;
}

const YAHOO_TW_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * 內外盤（逐筆成交依委買/委賣方向分類的量）——TWSE/TPEx 官方 OpenAPI、
 * 以及本專案其他地方用的 Yahoo 全球版 API（query1.finance.yahoo.com）都沒有
 * 這份資料，這是通常只有付費 Level 2 逐筆成交資料源才會提供的東西。
 *
 * 但 Yahoo 自己的「台灣在地化」股票網站 tw.stock.yahoo.com（跟前面那個全球版
 * API是完全不同的產品）在個股頁面上確實會顯示這個數字，來源是網頁原始碼裡
 * 一段內嵌的 JSON 資料（`inMarket`/`outMarket` 欄位），2026-09-15 直接 curl
 * 驗證過台積電頁面能撈到真實數字。花時間試過幾個猜測的內部 API 路徑
 * （`tw.stock.yahoo.com/_td-stock/api/resource/<name>`這個端點家族確實
 * 存在，但沒猜中能一次查詢多檔股票的輕量JSON批次資源名稱），最後還是只能
 * 抓完整個股頁面 HTML（約370KB）來挖。這代表這個資料來源**只適合「使用者
 * 正在看這一檔股票」的單次查詢**，不能用在需要一次查很多檔股票的列表
 * 排序/篩選——不會、也不應該被用在 searchStocks() 這類批次情境。
 *
 * 用鎖定 `"systexId":"<代號>"`（Yahoo內部的台股系統代號，值就是股票代號
 * 本身）當定位點，只在它後面一小段範圍內找 inMarket/outMarket，而不是對
 * 整頁368KB內容做全域比對——避免誤抓到頁面上「相關個股」「ETF成分股」等
 * 列表裡剛好也出現的其他股票的同名欄位。這段 HTML 結構完全沒有官方文件、
 * 屬於這個網頁自己的前端實作細節，改版時可能連欄位名稱一起換掉，屆時
 * getMarketDepth() 會如常地拿到 null（不會拋錯讓整個個股頁面掛掉），只是
 * 這張卡片會顯示「資料暫缺」。
 */
export async function fetchYahooTwMarketDepth(
  symbol: string,
  exchange: "TWSE" | "TPEx" | "Emerging" | undefined
): Promise<MarketDepth | null> {
  // 興櫃直接回 null，不是抓取失敗：內外盤的定義是「這筆成交是買方主動用賣價
  // 成交、還是賣方主動用買價成交」，前提是有集中撮合的委買委賣簿。興櫃是跟
  // 推薦券商一對一議價成交（見 lib/data/emerging.ts），根本沒有這個分類，
  // 櫃買中心也沒有公布。就算 Yahoo 頁面上真的印了兩個數字，對興櫃來說也不會
  // 是這個意思，所以寧可顯示「資料暫缺」也不拿來充數。
  if (exchange === "Emerging") return null;
  const suffix = exchange === "TPEx" ? "TWO" : "TW";
  const url = `https://tw.stock.yahoo.com/quote/${encodeURIComponent(symbol)}.${suffix}`;
  try {
    const res = await fetchWithTimeout(url, 6000, {
      headers: { "User-Agent": YAHOO_TW_UA, Accept: "text/html" },
    });
    const html = await res.text();
    const anchor = html.indexOf(`"systexId":"${symbol}"`);
    if (anchor === -1) return null;
    // A generous but bounded window past the anchor — confirmed live that
    // inMarket/outMarket sit within a few hundred characters of systexId in
    // the same quote object; bounding this (rather than searching the whole
    // page) is what keeps a same-named field from an unrelated part of the
    // page from ever being picked up.
    const nearby = html.slice(anchor, anchor + 1500);
    const inMatch = nearby.match(/"inMarket":(\d+)/);
    const outMatch = nearby.match(/"outMarket":(\d+)/);
    if (!inMatch || !outMatch) return null;
    return { inMarketLots: parseInt(inMatch[1], 10), outMarketLots: parseInt(outMatch[1], 10) };
  } catch {
    return null;
  }
}
