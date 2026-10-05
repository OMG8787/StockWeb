/**
 * 個股資料裡「近期相關新聞」與「籌碼面日期」的純邏輯（無 I/O），獨立出來方便測試。
 *
 * 2026-10-05 正式站：問「台積電今天法人和融資融券狀況？」，回答沒給台積電自己的法人數字，
 * 只給全市場「法人合計買超292.53億」，還夾了南電、景碩——兩者都來自個股新聞裡的一則
 * 盤後彙整標題「三大法人買賣超 – 外資買超(2327)國巨*、(2330)台積電，投信買超(8046)南電、
 * (3189)景碩，法人合計買超292.53億元」。另一個原因是盤中當天的個股法人（T86）還沒公布，
 * 籌碼面那行是上一個交易日的數字，但沒標清楚，模型就拿看起來像「今天」的新聞標題頂替。
 */

/** 標題裡用括號帶出的股票代號：(2330)、（2330）、(6488)，台股 4~6 碼（含 00 開頭 ETF）。 */
const BRACKETED_CODE = /[(（](\d{4,6}[A-Z]?)[)）]/g;

/**
 * 新聞標題是否為「多檔個股彙整」（例如法人買賣超排行、漲跌榜彙整）：括號帶出本檔以外的
 * 其他股票代號，就判定為彙整型標題。這類標題的數字（全市場合計）與其他個股都不是本檔資料，
 * 留著只會讓 AI 拿去頂替或扯入無關個股（RULE_ONLY_ASKED_STOCKS 擋不住資料本身的誤導）。
 */
export function isMultiStockRoundupTitle(title: string, symbol: string): boolean {
  const own = symbol.toUpperCase();
  for (const m of title.matchAll(BRACKETED_CODE)) {
    if (m[1].toUpperCase() !== own) return true;
  }
  return false;
}

/** 個股新聞：濾掉多檔彙整標題，每則前面加上台北日期（MM/DD），讓 AI 分得出新舊。 */
export function formatStockNewsLines(
  news: Array<{ title: string; source?: string; pubDate: string }>,
  symbol: string
): string[] {
  return news
    .filter((n) => !isMultiStockRoundupTitle(n.title, symbol))
    .map((n) => {
      const date = taipeiMonthDay(n.pubDate);
      return `- ${date ? `[${date}] ` : ""}${n.title}${n.source ? `（${n.source}）` : ""}`;
    });
}

function taipeiMonthDay(pubDate: string): string {
  const t = Date.parse(pubDate);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 8 * 60 * 60_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 籌碼面那行的標題：資料日不是今天（台北）時明講「今天的要收盤後才公布」。
 * 個股三大法人（證交所 T86／櫃買）約收盤後 15~16 點公布，融資融券約晚上 21 點後公布，
 * 盤中或非交易日看到的一定是最近一個交易日的數字。
 */
export function chipsSectionTitle(chipsDate: string | undefined, todayKey: string, todayIsWeekend = false): string {
  if (!chipsDate) return "籌碼面（最近一個交易日）";
  const md = chipsDate.slice(5).replace("-", "/");
  if (chipsDate >= todayKey) return `籌碼面（${md}，今天的資料）`;
  if (todayIsWeekend) return `籌碼面（${md}的資料，最近一個交易日；今天非交易日）`;
  const todayMd = todayKey.slice(5).replace("-", "/");
  return `籌碼面（${md}的資料；今天${todayMd}的個股三大法人買賣超要收盤後約15~16點、融資融券約21點後才公布，使用者問「今天」時要先講明這是${md}的數字）`;
}
