import { cached, cachedMap } from "./cache";
import type { Chips, Market } from "./types";
import { fetchTwseInstitutionalTradingAll } from "./twse";
import { fetchTpexInstitutionalTradingAll } from "./tpex";
import { mergeTwMaps } from "./twMergedMaps";
import { CHIPS_TTL_MS } from "./companyData";
import { searchStocks } from "./search";

export interface ChipsRankingItem {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  changePercent: number;
  netShares: number;
}

/** 全市場三大法人/外資買賣超排行，見 getChipsRanking()。 */
export interface ChipsRanking {
  institutionalBuy: ChipsRankingItem[];
  institutionalSell: ChipsRankingItem[];
  foreignBuy: ChipsRankingItem[];
  foreignSell: ChipsRankingItem[];
  trustBuy: ChipsRankingItem[];
}

// 2026-09-20：拉長到 1 小時，跟 CHIPS_TTL_MS 對齊——這個排行的依據（三大法人
// 買賣超）本身就是收盤後才公布一次的報表，理由同 CHIPS_TTL_MS 的說明。
const CHIPS_RANKING_TTL_MS = 60 * 60_000;
const CHIPS_RANKING_N = 10;

/**
 * 全市場「三大法人/外資/投信買賣超排行」。
 *
 * 跟 getValueScreen 同一個成因：使用者問「三大法人今天在買什麼？」「今天外資買超最多的
 * 是哪幾檔？」時，AI 只能從「技術訊號共振股」那 12 檔（先天只取當日漲跌幅最大的前 15 檔
 * 當候選）附帶的籌碼欄位裡挑，於是把幾檔剛好爆量漲停的小型股講成「法人today在買的股票」，
 * 或老實回答「資料裡沒有特別列出外資買超最多的幾檔」。但 getChips 底下那兩份
 * `chips:TW:institutional` / `chips:TW:margin` 快取本來就是**全市場**的對照表（TWSE 加
 * TPEx 每個交易日的完整三大法人買賣超），要排行只是排序而已，不需要任何新的資料源。
 *
 * 只做台股：美股沒有對應的公開籌碼資料源（getChips 對美股一律回傳 null）。
 */
export async function getChipsRanking(market: Market): Promise<ChipsRanking> {
  const empty: ChipsRanking = {
    institutionalBuy: [],
    institutionalSell: [],
    foreignBuy: [],
    foreignSell: [],
    trustBuy: [],
  };
  if (market !== "TW") return empty;
  return cached(`chips-ranking:${market}:v1`, CHIPS_RANKING_TTL_MS, async () => {
    const [items, institutionalMap] = await Promise.all([
      searchStocks({ market, sortBy: "turnover", sortDir: "desc" }),
      cachedMap("chips:TW:institutional", CHIPS_TTL_MS, () =>
        mergeTwMaps(fetchTwseInstitutionalTradingAll, fetchTpexInstitutionalTradingAll)
      ),
    ]);

    // 排行只涵蓋「站上有即時報價的股票」，這樣每一筆都能附上現價與今日漲跌幅，
    // 不會出現只有買賣超股數、沒有價格的半套資料。
    const rows = items
      .map((i) => ({ item: i, chips: institutionalMap.get(i.symbol) }))
      .filter((r): r is { item: (typeof items)[number]; chips: Chips } => r.chips != null);

    const rank = (pick: (c: Chips) => number | undefined, dir: "buy" | "sell"): ChipsRankingItem[] =>
      rows
        .map((r) => ({ r, net: pick(r.chips) }))
        .filter((x): x is { r: (typeof rows)[number]; net: number } =>
          x.net != null && (dir === "buy" ? x.net > 0 : x.net < 0)
        )
        .sort((a, b) => (dir === "buy" ? b.net - a.net : a.net - b.net))
        .slice(0, CHIPS_RANKING_N)
        .map(({ r, net }) => ({
          symbol: r.item.symbol,
          market: r.item.market,
          name: r.item.name,
          price: r.item.price,
          changePercent: r.item.changePercent,
          netShares: net,
        }));

    return {
      institutionalBuy: rank((c) => c.institutionalNetShares, "buy"),
      institutionalSell: rank((c) => c.institutionalNetShares, "sell"),
      foreignBuy: rank((c) => c.foreignNetShares, "buy"),
      foreignSell: rank((c) => c.foreignNetShares, "sell"),
      trustBuy: rank((c) => c.trustNetShares, "buy"),
    };
  });
}
