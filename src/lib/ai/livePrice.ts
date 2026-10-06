/**
 * 四入口「現價」顯示的唯一格式與解析（2026-10-07 使用者：「今日建議卡、關注名單分析、個股頁『問AI關於』、直接提問，
 * 新增都要顯示出現的股票當前的股價現價是多少」）。純函式、無 I/O，client／server 都能 import（有測試）。
 *
 * 格式固定：`現價 234（+6.4%，13:31）`；跟評等價不同時（評等有 10 分鐘快取、盤中價會動）：
 * `現價 236（+7.1%，13:31；評等以 234 計算）`——結論句裡「建議買進（現價 234 可分批買…）」的 234 是評等計算價，
 * 這裡明講，避免同一檔出現兩個「現價」讓人困惑。價格一律取即時報價（getQuote，/api/ask 在 withFreshLiveData 內會等新值），
 * 所有入口同一個來源、同一個格式化函式。
 */

export interface LiveQuoteInput {
  price: number;
  changePercent: number;
  currency?: string;
  /** 上游最近一筆成交時間（ISO）；沒有就不顯示時間（絕不拿抓取時間頂替，見 data/types.ts Quote.tradeTime） */
  tradeTime?: string;
}

/** 參考資料裡程式寫好的即時報價行：`【即時報價】名稱(代號)：現價 …`。 */
export const LIVE_QUOTE_TITLE = "【即時報價】";

/** 現價片段的辨識式（前端 30 秒輪詢更新時用它找出舊片段；評等句「現價 234 可分批買」後面沒有「（」所以不會誤中）。 */
export const LIVE_QUOTE_PATTERN = /現價 [\d,]+(?:\.\d+)?(?: 美元)?（[+\-]?\d+(?:\.\d+)?%(?:，[^）]*)?）/;

const fmtPrice = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

function taipeiParts(iso: string): { day: string; hm: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hm: `${get("hour")}:${get("minute")}` };
}

/** 報價時間：今天（台北）只寫 HH:MM，不是今天加 MM/DD（收盤後、週末看到的是上一個交易日的最後成交）。 */
export function formatQuoteTime(tradeTime: string | undefined, now: Date = new Date()): string {
  if (!tradeTime) return "";
  const t = taipeiParts(tradeTime);
  if (!t) return "";
  const today = taipeiParts(now.toISOString())?.day;
  return t.day === today ? t.hm : `${t.day.slice(5).replace("-", "/")} ${t.hm}`;
}

/** `現價 234（+6.4%，13:31）`；評等價（ratingPrice）跟現價不同時註明評等以哪個價算。 */
export function formatLiveQuote(q: LiveQuoteInput, ratingPrice?: number | null, now: Date = new Date()): string {
  const pct = Math.round(q.changePercent * 100) / 100;
  const sign = pct > 0 ? "+" : "";
  const time = formatQuoteTime(q.tradeTime, now);
  const differs = ratingPrice != null && Math.abs(ratingPrice - q.price) > 0.0049;
  const note = differs ? `評等以 ${fmtPrice(ratingPrice)} 計算` : "";
  const inner = [`${sign}${pct}%`, [time, note].filter(Boolean).join("；")].filter(Boolean).join("，");
  return `現價 ${fmtPrice(q.price)}${q.currency === "USD" ? " 美元" : ""}（${inner}）`;
}

/** 參考資料用的一行（每檔一行，回答後保證 ensureStockFactsMentioned 靠它取現價）。 */
export function describeLiveQuoteLine(name: string, symbol: string, q: LiveQuoteInput, ratingPrice?: number | null, now?: Date): string {
  return `${LIVE_QUOTE_TITLE}${name}(${symbol})：${formatLiveQuote(q, ratingPrice, now)}`;
}

export interface LiveQuoteEntry {
  name: string;
  symbol: string;
  /** 完整片段「現價 234（+6.4%，13:31）」 */
  text: string;
  /** 即時價（數字） */
  price: number;
}

const LIVE_LINE = /^【即時報價】(.+?)\(([0-9A-Za-z.\-]+)\)：(現價 ([\d,]+(?:\.\d+)?)[^\n]*)$/gm;

/** 參考資料裡每一檔的即時報價（同一檔取第一次）。 */
export function parseLiveQuotes(grounding: string): Map<string, LiveQuoteEntry> {
  const out = new Map<string, LiveQuoteEntry>();
  for (const m of grounding.matchAll(LIVE_LINE)) {
    const symbol = m[2].toUpperCase();
    if (!out.has(symbol)) out.set(symbol, { name: m[1].trim(), symbol, text: m[3].trim(), price: Number(m[4].replace(/,/g, "")) });
  }
  return out;
}

/** 評等行「（評等以現價 234 計算…）」的評等價；沒有 null。 */
export function ratingPriceFromGrounding(grounding: string, symbol: string): number | null {
  const line = grounding.split("\n").find((l) => l.includes("【本站綜合評等】") && l.includes(`(${symbol})`));
  const m = line?.match(/評等以現價 ([\d,]+(?:\.\d+)?) 計算/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/**
 * 前端輪詢拿到新報價後，把卡片文字裡每檔的舊「現價 X（…）」換成新的（只換含「(代號)」的那一行第一個片段）。
 * quotes：代號 → 新片段（formatLiveQuote 的結果）。
 */
export function patchLiveQuotes(text: string, quotes: Record<string, string>): string {
  return text
    .split("\n")
    .map((line) => {
      for (const [symbol, fresh] of Object.entries(quotes)) {
        if (line.includes(`(${symbol})`) && LIVE_QUOTE_PATTERN.test(line)) return line.replace(LIVE_QUOTE_PATTERN, fresh);
      }
      return line;
    })
    .join("\n");
}
