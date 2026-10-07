import { getChips, getQuote, searchStocks } from "@/lib/data";
import type { Market } from "@/lib/data";
import { formatSharesWithLots } from "@/lib/format";

// Users often ask about an informal "theme" of stocks (e.g. "AI概念股"、
// "半導體股"、"航運股") rather than either one specific stock or a generic
// "what's hot" question. Two tiers of theme resolution:
// 1. Official industry categories — TWSE/TPEx's own shared classification
//    (TW_INDUSTRY_NAMES in twse.ts, used by both exchanges since universe.ts
//    merged them) is already attached to every stock in the universe.
//    Mapping a theme keyword straight to one of these is safe: it's real
//    official classification data, not a judgment call this site is making.
// 2. A small hand-curated overlay for informal CROSS-sector groupings that
//    have no single official category (e.g. "AI概念股" spans chip design,
//    fab, AI-server ODM/assembly, and high-speed-interconnect makers) —
//    deliberately short and limited to names repeatedly and widely reported
//    in Taiwan financial media as core constituents, precisely because
//    there's no official source backing this one. The grounding text says
//    so explicitly so the model never presents it as an exhaustive or
//    official list.
export interface ThemeMatch {
  label: string;
  sector?: string;
  symbols?: Array<{ symbol: string; market: Market }>;
  curated?: boolean;
}

const SECTOR_THEMES: Array<{ pattern: RegExp; sector: string; label: string }> = [
  { pattern: /半導體(股|類股|產業)?/, sector: "半導體業", label: "半導體" },
  { pattern: /航運(股|類股)?/, sector: "航運業", label: "航運" },
  { pattern: /金融股|金融類股/, sector: "金融保險業", label: "金融" },
  { pattern: /生技(股|類股)?|生醫股/, sector: "生技醫療業", label: "生技醫療" },
  { pattern: /鋼鐵股|鋼鐵類股/, sector: "鋼鐵工業", label: "鋼鐵" },
  { pattern: /通信網路股|電信類股/, sector: "通信網路業", label: "通信網路" },
  { pattern: /光電股|光電類股/, sector: "光電業", label: "光電" },
  { pattern: /資訊服務股/, sector: "資訊服務業", label: "資訊服務" },
];

// 使用者問「XX概念股/XX類股/XX相關股有哪些」的通用形狀。用途不是拿來當篩選條件，
// 而是拿來偵測「這是一個主題式問題」——這樣即使 detectTheme 對不到任何主題，也知道
// 要明講「本站沒有這個主題的分類清單」，而不是讓 AI 拿今日焦點清單冒充。
//
// 實測抓到的真實問題：問「軍工概念股有哪些可以留意？」「機器人概念股有哪些可以留意？」
// 時，本站根本沒有這兩個主題的分類資料，但因為問句含「有哪些」而觸發了一般的
// 今日焦點資料，AI 就把長園科(8038)、天鉞電(5251)、台灣精材(3467) 這些當天剛好爆量
// 漲停的股票寫成「以下是本站整理的常見軍工概念股清單」「台股常見的機器人概念股清單」
// ——這些公司跟軍工/機器人沒有關係，等於憑空捏造了一個產業分類掛在真實公司身上，
// 比單純答不出來嚴重得多（新手可能真的because這句話去買）。同一批測試裡問「綠能概念股」
// 「重電股」「國防航太類股」時卻又誠實回答「本站沒有這個分類」，代表沒有規則約束、
// 全看模型當下心情，所以這裡補上明確的標記與 system prompt 規則。
export const THEME_QUESTION_PATTERN = /(概念股|相關股|類股|族群|供應鏈|概念類股)/;

const AI_THEME_SYMBOLS: Array<{ symbol: string; market: Market }> = [
  { symbol: "2330", market: "TW" }, // 台積電
  { symbol: "2317", market: "TW" }, // 鴻海
  { symbol: "2454", market: "TW" }, // 聯發科
  { symbol: "2382", market: "TW" }, // 廣達
  { symbol: "3231", market: "TW" }, // 緯創
  { symbol: "2356", market: "TW" }, // 英業達
  { symbol: "6669", market: "TW" }, // 緯穎
  { symbol: "3661", market: "TW" }, // 世芯-KY
  { symbol: "2308", market: "TW" }, // 台達電
];

export function detectTheme(question: string): ThemeMatch | undefined {
  if (/AI(概念股|相關股|供應鏈|伺服器)|人工智慧(概念股|相關股)/.test(question)) {
    return { label: "AI供應鏈", symbols: AI_THEME_SYMBOLS, curated: true };
  }
  for (const { pattern, sector, label } of SECTOR_THEMES) {
    if (pattern.test(question)) return { label, sector };
  }
  return undefined;
}

const THEME_SYMBOL_LIMIT = 10;
const THEME_CHIP_LIMIT = 5;
// 一個官方產業分類裡「最具代表性」的幾檔（依今日成交金額，等同於市場資金最關注的
// 龍頭/主流股）一定要先保留位置，剩下的位置才給「今日漲最多」的。
//
// 原本這裡只有 sortBy: "changePercent" 一種排序，結果實測問「航運股最近怎麼樣？」時，
// 回答列出的是志信(2611)、遠雄港(5607)、宅配通(2642)、捷迅(2643) 這些今天剛好小漲
// 0.x% 的小型物流股，長榮(2603)、陽明(2609)、萬海(2615) 這些使用者心裡真正在問的
// 航運龍頭一檔都沒出現（因為它們今天是跌的，排在漲幅榜後面）；問「半導體類股今天
// 表現如何」同樣沒有台積電、聯發科。資料本身沒錯，但對使用者來說等於答非所問。
const THEME_BELLWETHER_LIMIT = 5;

export async function buildThemeGrounding(theme: ThemeMatch): Promise<string> {
  try {
    let pool: Array<{ symbol: string; market: Market; name: string; price: number; changePercent: number }>;
    if (theme.sector) {
      const [byTurnover, byChange] = await Promise.all([
        searchStocks({ market: "TW", sectors: [theme.sector], sortBy: "turnover", sortDir: "desc" }),
        searchStocks({ market: "TW", sectors: [theme.sector], sortBy: "changePercent", sortDir: "desc" }),
      ]);
      const picked = new Map<string, (typeof byTurnover)[number]>();
      for (const s of byTurnover.slice(0, THEME_BELLWETHER_LIMIT)) picked.set(s.symbol, s);
      for (const s of byChange) {
        if (picked.size >= THEME_SYMBOL_LIMIT) break;
        if (!picked.has(s.symbol)) picked.set(s.symbol, s);
      }
      pool = [...picked.values()].sort((a, b) => b.changePercent - a.changePercent);
    } else if (theme.symbols) {
      const quotes = await Promise.all(theme.symbols.map((s) => getQuote(s.symbol, s.market).catch(() => null)));
      pool = quotes
        .filter((q): q is NonNullable<typeof q> => q !== null)
        .map((q) => ({ symbol: q.symbol, market: q.market, name: q.name, price: q.price, changePercent: q.changePercent }))
        .sort((a, b) => b.changePercent - a.changePercent);
    } else {
      return "";
    }
    if (pool.length === 0) return "";

    const shown = pool.slice(0, THEME_SYMBOL_LIMIT);
    const chipEntries = await Promise.all(
      shown.slice(0, THEME_CHIP_LIMIT).map(async (s) => [s.symbol, await getChips(s.symbol, "TW").catch(() => null)] as const)
    );
    const chipsMap = new Map(chipEntries);
    const lines = shown.map((s) => {
      const chip = chipsMap.get(s.symbol);
      const chipText = chip?.institutionalNetShares != null ? `；三大法人${formatSharesWithLots(chip.institutionalNetShares)}` : "";
      return `${s.name}(${s.symbol})：${s.price} ${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%${chipText}`;
    });
    const note = theme.curated
      ? `（本站整理的常見${theme.label}相關個股，非完整或官方分類清單，僅供參考）`
      : `（依 TWSE/TPEx 官方產業分類「${theme.sector}」挑出：先取今日成交金額最大的幾檔——也就是這個類股裡資金最集中、最具代表性的主流股，再補上今日漲幅較大的其他個股，最後依今日漲跌幅排序，共列 ${shown.length} 檔。這不是整個類股的完整名單，回答時不要說成「這個類股只有這幾檔」）`;
    return `${note}\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/** 問句提到的所有官方產業類股（類股比較題用；detectTheme 只回第一個）。 */
export function detectSectorThemes(question: string): ThemeMatch[] {
  return SECTOR_THEMES.filter((t) => t.pattern.test(question)).map(({ sector, label }) => ({ label, sector }));
}

/**
 * 類股比較（2026-10-07 開放題評測：問「半導體跟航運類股最近哪個比較強」，只附了半導體一個類股，模型只能答「查不到航運」）。
 * 每個類股用官方產業分類的全部個股算今天的漲跌家數、成交金額加權漲跌幅（程式算好，AI 照數字比較），再附各自的代表股。
 */
export async function buildSectorCompareGrounding(themes: ThemeMatch[]): Promise<string> {
  const rows = await Promise.all(
    themes.map(async (t) => {
      if (!t.sector) return "";
      const all = await searchStocks({ market: "TW", sectors: [t.sector], sortBy: "turnover", sortDir: "desc" }).catch(() => []);
      if (all.length === 0) return `${t.label}（${t.sector}）：這次讀不到資料`;
      const up = all.filter((s) => s.changePercent > 0).length;
      const down = all.filter((s) => s.changePercent < 0).length;
      const turnover = all.reduce((a, s) => a + (s.turnover ?? 0), 0);
      const weighted = turnover > 0 ? all.reduce((a, s) => a + s.changePercent * (s.turnover ?? 0), 0) / turnover : 0;
      const top = all
        .slice(0, 3)
        .map((s) => `${s.name}(${s.symbol}) ${s.changePercent >= 0 ? "+" : ""}${s.changePercent}%`)
        .join("、");
      return `${t.label}（官方產業分類「${t.sector}」共 ${all.length} 檔）：今天上漲 ${up} 檔、下跌 ${down} 檔，成交金額加權平均漲跌 ${weighted >= 0 ? "+" : ""}${weighted.toFixed(2)}%，成交金額約 ${Math.round(turnover / 1e8)} 億元；成交最大的代表股：${top}`;
    })
  );
  const body = rows.filter(Boolean);
  if (body.length < 2) return "";
  return `【類股比較（程式依官方產業分類全部個股算好，只有今天的漲跌；更長期間的類股表現本站沒有，回答時照實說）】\n${body.join("\n")}`;
}
