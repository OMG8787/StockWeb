import { getTechnicalScreen } from "@/lib/data";
import type { TechScreenItem } from "@/lib/data";
import { describeTechState } from "./indicators";

// 明細表最多列幾檔：凡是「今天有任一交叉」的一律全部列出（這才是多重指標
// 篩選真正會用到的母體，通常一天只有十幾檔），另外再補上成交金額最大的
// 幾檔（讓「台積電現在技術面如何」這類問法也有數值可引用）。
const TECH_TABLE_EXTRA_BY_TURNOVER = 25;

/**
 * 「多重技術指標同時符合」的篩選資料。
 *
 * 使用者要求：問「現在有沒有MACD與KD線都在黃金交叉，適合明天買入的股票?」
 * 這種同時要符合多個技術條件的問題時，要真的去查證資料、確定回答內容正確。
 * 2026-09-16 實測的真實 bug：當天市場上確實有股票同時符合（嘉基6715），
 * AI 卻回答「資料裡沒有同時列出MACD與KD都黃金交叉的股票」——因為舊的
 * 「技術訊號共振股」只掃當日漲跌幅前15檔（見 getTechnicalScreen 的註解），
 * 而且舊的 KD 訊號只認低檔交叉（見 lib/signals.ts 的 KD 註解），兩個原因
 * 疊在一起讓正確答案根本不可能出現在 AI 手上。
 *
 * 這裡把常見組合先用程式算好交集（而不是把一堆資料丟給 AI 讓它自己配對，
 * 那正是會出錯的地方），同時附上完整的指標明細表，讓沒有事先列舉到的
 * 其他組合（例如「均線多頭排列＋RSI未過熱＋站上20日均線」）也有真實數值
 * 可以逐檔核對。
 */
export async function buildTechScreenGrounding(): Promise<string> {
  const [tw, us] = await Promise.all([
    getTechnicalScreen("TW").catch(() => [] as TechScreenItem[]),
    getTechnicalScreen("US").catch(() => [] as TechScreenItem[]),
  ]);
  if (tw.length === 0 && us.length === 0) return "";

  const blockFor = (items: TechScreenItem[], marketLabel: string, scanned: number): string => {
    if (items.length === 0) return "";
    const fmtList = (list: TechScreenItem[]) =>
      list.length === 0
        ? "（今天掃描範圍內一檔都沒有，這是實際比對過每一檔指標後的結果，可以直接回答「今天沒有」）"
        : list.map((i) => `- ${describeTechState(i)}`).join("\n");

    const macdGolden = items.filter((i) => i.state.macdCross === "golden");
    const macdDeath = items.filter((i) => i.state.macdCross === "death");
    const kdGolden = items.filter((i) => i.state.kd?.cross === "golden");
    const kdDeath = items.filter((i) => i.state.kd?.cross === "death");
    const bothGolden = items.filter((i) => i.state.macdCross === "golden" && i.state.kd?.cross === "golden");
    const bothDeath = items.filter((i) => i.state.macdCross === "death" && i.state.kd?.cross === "death");
    const bullishMaHealthyRsi = items.filter(
      (i) => i.state.maAlignment === "bullish" && i.state.rsi != null && i.state.rsi < 70
    );
    const bullishMaMacdGolden = items.filter(
      (i) => i.state.maAlignment === "bullish" && i.state.macdCross === "golden"
    );
    const oversoldTurning = items.filter(
      (i) => i.state.kd?.cross === "golden" && i.state.rsi != null && i.state.rsi <= 40
    );

    const crossed = items.filter((i) => i.state.macdCross !== null || i.state.kd?.cross != null);
    const crossedSymbols = new Set(crossed.map((i) => i.symbol));
    const extras = items
      .slice()
      .sort((a, b) => b.turnover - a.turnover)
      .filter((i) => !crossedSymbols.has(i.symbol))
      .slice(0, TECH_TABLE_EXTRA_BY_TURNOVER);
    const tableRows = [...crossed, ...extras];

    return [
      `【${marketLabel}多重技術指標篩選】掃描範圍：依今日成交金額由大到小的前 ${scanned} 檔${marketLabel}（不是全部上市櫃股票；這個排序跟「有沒有發生指標交叉」完全無關，所以不會系統性漏掉某一類股票，但極冷門、幾乎沒有成交的股票不在範圍內）。以下每一檔的指標都是用該檔近3個月真實日K線當場算出來的，不是估計值。`,
      `${marketLabel}「MACD黃金交叉 且 KD黃金交叉」同時成立（共${bothGolden.length}檔）：\n${fmtList(bothGolden)}`,
      `${marketLabel}「MACD死亡交叉 且 KD死亡交叉」同時成立（共${bothDeath.length}檔）：\n${fmtList(bothDeath)}`,
      `${marketLabel}今日 MACD黃金交叉（共${macdGolden.length}檔）：\n${fmtList(macdGolden)}`,
      `${marketLabel}今日 KD黃金交叉（K值上穿D值，共${kdGolden.length}檔；括號裡會註明發生在低檔/中間/高檔，低檔交叉是最標準的轉強訊號，高檔交叉要留意追高風險）：\n${fmtList(kdGolden)}`,
      `${marketLabel}今日 MACD死亡交叉（共${macdDeath.length}檔）：\n${fmtList(macdDeath)}`,
      `${marketLabel}今日 KD死亡交叉（共${kdDeath.length}檔）：\n${fmtList(kdDeath)}`,
      `${marketLabel}「均線多頭排列 且 RSI未過熱（RSI<70）」（共${bullishMaHealthyRsi.length}檔）：\n${fmtList(bullishMaHealthyRsi)}`,
      `${marketLabel}「均線多頭排列 且 MACD黃金交叉」（共${bullishMaMacdGolden.length}檔）：\n${fmtList(bullishMaMacdGolden)}`,
      `${marketLabel}「KD黃金交叉 且 RSI仍低（RSI≤40，尚未漲多）」（共${oversoldTurning.length}檔）：\n${fmtList(oversoldTurning)}`,
      `${marketLabel}技術指標明細表（今天有發生任一交叉的全部列出，另補上成交金額最大的幾檔；使用者問到上面沒有預先列出的其他指標組合時，一律從這張表逐檔比對後回答，不要自己回想或推測）：\n${tableRows.map((i) => `- ${describeTechState(i)}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  return [blockFor(tw, "台股", tw.length), blockFor(us, "美股", us.length)].filter(Boolean).join("\n\n");
}
