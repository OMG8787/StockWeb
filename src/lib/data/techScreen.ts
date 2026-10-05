import { mapWithConcurrency } from "./cache";
import type { Market } from "./types";
import { computeIndicatorState, computeSignals, type IndicatorState, type Signal } from "@/lib/signals";
import { searchStocks } from "./search";
import { getChart } from "./chart";
import { cachedListWithDegradedEmptyTtl } from "./degradedCache";
import { HEAVY_SWR_MS, sessionAwareTtl } from "./swrPolicy";

export interface TechScreenItem {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  changePercent: number;
  turnover: number;
  /** 每個技術指標「當下的實際狀態值」，見 lib/signals.ts 的 IndicatorState。 */
  state: IndicatorState;
  /** 同一組 K 線算出來、已經觸發的中文訊號標籤（跟個股頁上顯示的完全一致）。 */
  signals: Signal[];
}

// 2026-09-20：拉長到 30 分鐘——這是全站最貴的一項背景計算（要對成交金額
// 前120檔台股+60檔美股各抓一次K線），5分鐘的 warm-cache 排程若每次都重算這個，
// 是 Vercel 免費方案用量吃緊後盤點出來的最大浪費源頭，30分鐘仍然遠比技術指標
// 交叉訊號實際變化的速度新鮮很多。
const TECH_SCREEN_TTL_MS = 30 * 60_000;
// 空結果（一檔都沒算出來）專用的短 TTL——見
// cachedListWithDegradedEmptyTtl() 的完整說明。
const TECH_SCREEN_DEGRADED_TTL_MS = 60_000;
// 掃描範圍：依今日成交金額（＝市場資金實際關注度）由大到小取前 N 檔。
//
// 為什麼不沿用 getMultiSignalStocks 那個「當日漲跌幅最大前15檔」的候選池：
// 使用者要求「問『有沒有MACD與KD都黃金交叉的股票』這種多重指標篩選時，要真的
// 去查證資料」。實測（2026-09-16）用獨立腳本掃描台股成交金額前150檔發現，當天
// 真的有一檔嘉基(6715) 同時符合 MACD 黃金交叉 + K值上穿D值，但它當天只漲 3.32%、
// 完全排不進全市場漲跌幅前15名，所以 getMultiSignalStocks 從一開始就不會把它
// 納入候選，AI 手上根本沒有這筆資料，只能誠實回答「沒有」——跟先前「連漲N天」
// 那個 bug 是同一個根因：**候選池的挑選標準（漲跌幅）跟使用者問的條件（技術
// 指標交叉）根本無關**。技術指標交叉天生就常發生在漲幅普通的股票上（MACD 剛
// 黃金交叉通常只是小漲一根），用漲跌幅當入場券等於系統性地把答案濾掉。
//
// 改用成交金額排序的理由：①它跟「有沒有發生交叉」完全無關，不會造成上述那種
// 系統性偏誤；②技術指標對幾乎沒有人交易的殭屍股本來就沒有參考價值（算得出
// 漂亮的黃金交叉也買不到、賣不掉），用流動性當門檻同時也是對使用者負責。
// 這仍然不是「全市場每一檔」（那需要對上千檔各抓一次K線，對上游是不可行的
// 請求量），所以清單本身、以及送進 AI 的說明文字都必須誠實標示掃描範圍。
const TECH_SCREEN_CANDIDATE_LIMIT: Record<Market, number> = { TW: 120, US: 60 };
// 抓K線的併發上限。跟 getVolumeSurgeStocks 用同一個量級（它已經在正式站穩定
// 跑 60 檔），且兩者候選池高度重疊、getChart 本身有快取，重複的部分是免費的。
const TECH_SCREEN_CHART_CONCURRENCY = 20;

/**
 * 上一次真的重算 getTechnicalScreen 時的執行摘要（候選池幾檔、成功幾檔、
 * K線抓不到幾檔），給 /api/cron/warm-cache 回報用。
 *
 * 為什麼需要這個：2026-09-20 追「AI 說沒有台股技術指標清單」這個 bug 時，
 * 外面唯一看得到的訊息是「這份清單是空的」，完全無法分辨到底是「候選池
 * （searchStocks）本身就是 0 筆」還是「候選池有 120 檔但每一檔的 K 線都抓不
 * 到」——這兩種是完全不同的根因、要往完全不同的方向修。console.error 在正式
 * 站當下拿不到，只能靠反覆間接量測猜，浪費很多時間。把這個摘要留下來，之後
 * 同類問題可以直接看出是哪一段斷掉。
 */
const lastTechScreenRun: Record<string, string> = {};

export function getLastTechScreenRun(): Record<string, string> {
  return { ...lastTechScreenRun };
}

/**
 * 全市場（成交金額前 N 檔）的「每一檔技術指標實際狀態」快照，專門用來支援
 * 「多重技術指標同時符合」的篩選問題。
 *
 * 跟 getMultiSignalStocks 的關鍵差異有兩個：
 * 1. 候選池用成交金額而非當日漲跌幅挑（見上方 TECH_SCREEN_CANDIDATE_LIMIT 註解），
 *    範圍也大 8 倍，不會系統性漏掉漲幅普通但剛發生指標交叉的股票。
 * 2. 回傳的是結構化的指標數值（有沒有交叉、K/D 幾點、RSI 幾點、均線什麼排列），
 *    不是只有中文標籤字串，所以呼叫端可以用程式做任意組合的交集篩選
 *    （「MACD黃金交叉 且 KD黃金交叉」「均線多頭排列 且 RSI<70」…），
 *    而不是靠 AI 看著標籤自己猜。
 */
export async function getTechnicalScreen(market: Market): Promise<TechScreenItem[]> {
  return cachedListWithDegradedEmptyTtl(
    // v2（2026-10-05）：IndicatorState 新增 kdNearCross／macdNearCross（即將交叉），舊快取沒有這兩欄。
    `tech-screen:${market}:v2`,
    // 收盤後／週末 TTL 拉長到 3 小時（sessionAwareTtl，Active CPU 吃緊）。
    sessionAwareTtl(market, TECH_SCREEN_TTL_MS),
    TECH_SCREEN_DEGRADED_TTL_MS,
    async () => {
      const pool = await searchStocks({ market, sortBy: "turnover", sortDir: "desc" });
      const candidates = pool.slice(0, TECH_SCREEN_CANDIDATE_LIMIT[market]);

      const results = await mapWithConcurrency(
        candidates,
        TECH_SCREEN_CHART_CONCURRENCY,
        async (item): Promise<TechScreenItem | null> => {
          // 逐檔各自 try/catch：mapWithConcurrency 底下是 Promise.all，任何一檔
          // 拋例外就會讓「整個市場」的篩選結果一起變成 rejected，呼叫端
          // （buildTechScreenGrounding 的 .catch(() => [])）再把它吞成空陣列——
          // 結果就是 120 檔裡只要有 1 檔的 K 線抓取出錯，AI 就會回答「資料裡沒有
          // 台股的技術指標篩選清單」，而且因為錯誤被吞掉、外面完全看不出原因。
          // 單一檔抓不到就跳過那一檔（照 getChart 回傳 null 時本來就有的處理），
          // 才是正確的降級方式。
          try {
            const chart = await getChart(item.symbol, "3m", item.market);
            if (!chart) return null;
            const state = computeIndicatorState(chart.candles, item.price);
            if (!state) return null;
            return {
              symbol: item.symbol,
              market: item.market,
              name: item.name,
              price: item.price,
              changePercent: item.changePercent,
              turnover: item.turnover,
              state,
              signals: computeSignals(chart.candles, item.price, "3m"),
            };
          } catch (err) {
            console.error(`[tech-screen] ${item.market} ${item.symbol} 指標計算失敗，跳過這一檔：`, err);
            return null;
          }
        }
      );

      const kept = results.filter((r): r is TechScreenItem => r !== null);
      lastTechScreenRun[market] =
        `候選池 ${pool.length} 檔（取前 ${candidates.length}）→ 成功 ${kept.length} 檔、抓不到K線或指標算不出來 ${candidates.length - kept.length} 檔，於 ${new Date().toISOString()}`;
      return kept;
    },
    // 全市場掃描很貴：過期先回舊清單、背景重算（空清單不會蓋掉舊清單），見 swrPolicy.ts。
    { staleWhileRevalidateMs: HEAVY_SWR_MS }
  );
}
