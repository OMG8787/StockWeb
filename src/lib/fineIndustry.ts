import type { Market } from "@/lib/data";

/**
 * 「細分產業」分類表 —— 本站自行整理，**不是**官方分類。
 *
 * 為什麼不直接用 universe.ts 既有的 `sector` 欄位：那是交易所官方的產業別
 * （「半導體業」「光電業」「電子零組件」…），範圍太廣——欣興(載板)、台積電
 * (晶圓代工)、聯詠(IC設計) 在官方分類裡全都是「半導體業」，但對看盤的人來說
 * 它們的產業循環、題材、股價驅動因素完全不同，排在一起沒有意義。使用者要的是
 * 「實際做的內容相似」的族群——載板、矽光子/CPO、散熱、被動元件這種顆粒度。
 *
 * 這份表的定位跟 `lib/ai/ask.ts` 的 `AI_THEME_SYMBOLS` 完全一樣：
 * **手動精選、盡力而為、非官方權威**。它有三個先天限制，維護時務必記得：
 *   1. **不完整**：只涵蓋關注清單裡實際比較可能出現的主流公司，沒有窮舉全台股
 *      ~1900 檔。對不到任何族群的股票一律歸到 `OTHER_FINE_INDUSTRY`（「其他」），
 *      這是正常結果，不是 bug。
 *   2. **會過時**：公司會轉型、會合併（例如晶電+隆達合併成富采）、會切入新領域。
 *      這裡的歸類是寫下當時的主流認知，不會自動跟著公司變化更新。
 *   3. **一檔只放一組**：很多公司橫跨多個族群（台達電同時是電源、散熱、電動車
 *      零件；鴻海同時是組裝、機殼、電動車），這裡只挑「市場上最常拿來歸類它」
 *      的那一組，方便排序時每檔只出現一次。
 *
 * 所以它只能拿來做「排版上把相似的股票排在一起」這種輔助用途，**絕對不要**
 * 把它當成官方產業別去做統計、篩選條件或任何對外宣稱的分類依據。UI 上有標註
 * 「產業分類為本站整理、非官方分類」，改動時請一併維持那個說明。
 *
 * 排序時的分組順序 = 下面陣列的順序（同市場內），所以相近的上下游族群刻意排在
 * 一起（例如半導體上游→設計→製造→封測→載板→材料），讓整份清單掃過去時
 * 有產業鏈的脈絡，而不是一堆隨機順序的標籤。
 */
export interface FineIndustryGroup {
  /** 顯示用的族群名稱（目前只在程式內部與排序用，沒有直接顯示在表格上）。 */
  label: string;
  market: Market;
  /** 台股為股票代號、美股為 ticker（大寫）。 */
  symbols: string[];
}

/** 對不到任何細分族群時的歸類。排序時一律排在所有已分類族群之後。 */
export const OTHER_FINE_INDUSTRY = "其他";

/** 任何顯示這份細分產業分類的地方（關注清單、搜尋結果、焦點排行）都共用同一段
 *  說明，避免使用者誤以為是交易所的官方產業別，也避免多處各自維護一份文字、
 *  之後改一邊忘了改另一邊。 */
export const FINE_INDUSTRY_HINT =
  "把實際做的內容相近的股票排在一起（例如載板、矽光子/CPO、散熱、被動元件），比官方的「半導體業」「光電業」更細。此分類為本站整理、盡力而為，非官方權威分類，也沒有涵蓋全部股票——沒收錄到的股票會改顯示交易所官方的產業別（排序時排在最後）。";

export const FINE_INDUSTRY_GROUPS: FineIndustryGroup[] = [
  // ── 台股：半導體產業鏈（由上游設備/材料往下游封測、載板排）──────────
  { label: "晶圓代工／晶圓製造", market: "TW", symbols: ["2330", "2303", "5347", "6770"] },
  { label: "矽晶圓", market: "TW", symbols: ["6488", "5483", "3532"] },
  { label: "IC設計", market: "TW", symbols: ["2454", "3034", "2379", "6415", "4966", "5269", "3014", "8016", "6202", "3006"] },
  { label: "ASIC設計服務／矽智財", market: "TW", symbols: ["3443", "3661", "3529", "6643", "6533"] },
  { label: "記憶體（DRAM／NAND）", market: "TW", symbols: ["2408", "2344", "3260"] },
  { label: "記憶體模組／儲存控制IC", market: "TW", symbols: ["8299", "4967", "5289", "2451"] },
  { label: "封測／先進封裝", market: "TW", symbols: ["3711", "2449", "6239", "2441", "6147", "8150", "3374"] },
  { label: "半導體設備／零組件", market: "TW", symbols: ["3680", "3583", "3131", "2467", "6187", "6510", "3587"] },
  { label: "IC載板（ABF／BT）", market: "TW", symbols: ["3037", "8046", "3189"] },
  { label: "PCB／銅箔基板（CCL）", market: "TW", symbols: ["2383", "6213", "2368", "2313", "3044", "8213", "2367"] },
  { label: "軟板（FPC）", market: "TW", symbols: ["6269", "6153", "3313"] },
  { label: "矽光子／CPO／光通訊元件", market: "TW", symbols: ["3363", "3081", "4977", "6442", "4979", "3163", "4908", "3450", "3234"] },

  // ── 台股：AI 伺服器／電子組裝與周邊 ──────────────────────────────
  { label: "伺服器／電子代工組裝", market: "TW", symbols: ["2317", "2382", "3231", "2356", "6669", "2357", "2376", "2377", "4938", "2353"] },
  { label: "散熱（風扇／水冷／均熱片）", market: "TW", symbols: ["3017", "3324", "2421", "6230", "3653", "8996"] },
  { label: "機殼／機構件（含伺服器滑軌）", market: "TW", symbols: ["2354", "2474", "2059"] },
  { label: "連接器／線材", market: "TW", symbols: ["3023", "2392", "3665", "6805"] },
  { label: "電源供應器／能源管理", market: "TW", symbols: ["2308", "6409", "6412"] },
  { label: "工業電腦", market: "TW", symbols: ["2395", "6414", "6579"] },
  { label: "電子零組件通路", market: "TW", symbols: ["3702", "2347", "3033"] },
  { label: "被動元件（MLCC／電阻）", market: "TW", symbols: ["2327", "2492", "3026", "2375"] },
  { label: "網通設備", market: "TW", symbols: ["2345", "6285", "3704", "5388", "3380", "4906", "2419"] },

  // ── 台股：光電／面板／光學 ──────────────────────────────────────
  { label: "光學鏡頭／光學模組", market: "TW", symbols: ["3008", "3406", "6456"] },
  { label: "面板（LCD／OLED）", market: "TW", symbols: ["2409", "3481", "6116"] },
  { label: "電子紙", market: "TW", symbols: ["8069"] },
  { label: "LED", market: "TW", symbols: ["3714", "2393"] },

  // ── 台股：傳統產業 ──────────────────────────────────────────────
  { label: "貨櫃航運", market: "TW", symbols: ["2603", "2609", "2615"] },
  { label: "散裝／油輪航運", market: "TW", symbols: ["2637", "2606", "2617", "2605", "5608"] },
  { label: "航空客貨運", market: "TW", symbols: ["2610", "2618"] },
  { label: "貨運承攬／物流", market: "TW", symbols: ["2636", "2642", "2643"] },
  { label: "鋼鐵", market: "TW", symbols: ["2002", "2027", "2023", "2015", "2014"] },
  { label: "水泥", market: "TW", symbols: ["1101", "1102"] },
  { label: "塑化／石化", market: "TW", symbols: ["1301", "1303", "1326", "6505", "1314"] },
  { label: "紡織成衣／製鞋", market: "TW", symbols: ["1402", "1476", "1477", "9910", "9904"] },
  { label: "重電／電網設備", market: "TW", symbols: ["1519", "1513", "1503", "1514", "1504"] },
  { label: "綠能／太陽能／風電", market: "TW", symbols: ["6244", "3576", "9958"] },
  { label: "電池模組／電池材料", market: "TW", symbols: ["6121", "3211", "1723", "3691"] },
  { label: "汽車整車／車用零組件", market: "TW", symbols: ["2201", "2207", "2227", "2231", "1536"] },
  { label: "自動化／傳動元件", market: "TW", symbols: ["2049", "1590", "4551"] },
  { label: "航太／軍工", market: "TW", symbols: ["2634", "2645", "8033"] },

  // ── 台股：生技醫療（官方全掛在「生技醫療業」，實務上差很多）────────
  { label: "新藥研發", market: "TW", symbols: ["4174", "6446", "4147", "6535", "4192"] },
  { label: "疫苗／檢驗試劑", market: "TW", symbols: ["6547", "4142", "4736"] },
  { label: "學名藥／原料藥／CDMO", market: "TW", symbols: ["1795", "4123", "4746", "4166", "6472"] },
  { label: "醫療器材／隱形眼鏡", market: "TW", symbols: ["4107", "6491", "1565", "4116"] },
  { label: "保健食品", market: "TW", symbols: ["1707", "4205"] },

  // ── 台股：金融（官方一律「金融保險業」，這裡拆成銀行／壽險／證券）──
  { label: "銀行／偏銀行金控", market: "TW", symbols: ["2886", "2891", "2884", "2892", "2880", "5880", "2887", "2890", "2801", "2834", "2812"] },
  { label: "壽險／偏壽險金控", market: "TW", symbols: ["2881", "2882", "2883"] },
  { label: "證券／期貨", market: "TW", symbols: ["2885", "6005", "2855", "6016"] },

  // ── 台股：內需服務 ─────────────────────────────────────────────
  { label: "電信", market: "TW", symbols: ["2412", "3045", "4904"] },
  { label: "食品飲料", market: "TW", symbols: ["1216", "1210", "1201", "1227", "1229"] },
  { label: "餐飲連鎖", market: "TW", symbols: ["2723", "2727", "2729"] },
  { label: "零售通路", market: "TW", symbols: ["2912", "5903", "2903", "2915"] },
  { label: "觀光旅遊", market: "TW", symbols: ["2731", "2707", "2705", "5706"] },
  { label: "營建／資產", market: "TW", symbols: ["2542", "5522", "2597", "2504"] },
  { label: "軟體／資訊服務", market: "TW", symbols: ["6214", "5203", "2471", "6183", "3029", "6811"] },
  { label: "遊戲／數位內容", market: "TW", symbols: ["3293", "6180", "5478"] },

  // ── 美股：官方 GICS 的 Technology 一格塞了晶片、設備、軟體、硬體，
  //         對使用者一樣太籠統，所以同樣拆細 ───────────────────────
  { label: "AI晶片／半導體", market: "US", symbols: ["NVDA", "AMD", "AVGO", "MRVL", "QCOM", "INTC", "TXN", "ADI", "ON", "MU", "TSM"] },
  { label: "半導體設備／EDA", market: "US", symbols: ["AMAT", "LRCX", "KLAC", "SNPS", "CDNS"] },
  { label: "雲端／企業軟體", market: "US", symbols: ["MSFT", "ORCL", "CRM", "NOW", "SNOW", "WDAY", "TEAM", "INTU", "ADBE", "IBM", "ACN", "ADP"] },
  { label: "資安／網路基礎建設", market: "US", symbols: ["PANW", "CRWD", "FTNT", "NET", "DDOG", "CSCO"] },
  { label: "消費電子／PC硬體", market: "US", symbols: ["AAPL", "DELL", "HPQ"] },
  { label: "電商／網路平台", market: "US", symbols: ["AMZN", "UBER", "ABNB", "BKNG"] },
  { label: "社群／廣告平台", market: "US", symbols: ["GOOGL", "META"] },
  { label: "串流媒體／娛樂內容", market: "US", symbols: ["NFLX", "DIS", "CMCSA", "WBD", "EA", "TTWO"] },
  { label: "電信", market: "US", symbols: ["T", "VZ", "TMUS"] },
  { label: "電動車／汽車", market: "US", symbols: ["TSLA", "GM", "F"] },
  { label: "零售通路", market: "US", symbols: ["WMT", "COST", "TGT", "HD", "LOW", "TJX", "ROST"] },
  { label: "餐飲連鎖", market: "US", symbols: ["MCD", "SBUX", "CMG", "YUM", "MAR"] },
  { label: "民生消費品", market: "US", symbols: ["PG", "KO", "PEP", "CL", "MDLZ", "KHC", "STZ", "KMB", "GIS", "SYY", "PM", "MO", "NKE"] },
  { label: "製藥", market: "US", symbols: ["LLY", "JNJ", "ABBV", "MRK", "PFE", "BMY", "AMGN", "GILD", "VRTX", "REGN", "ZTS"] },
  { label: "醫療器材／生技設備", market: "US", symbols: ["ISRG", "MDT", "SYK", "BSX", "ABT", "TMO", "DHR"] },
  { label: "醫療保險／醫療服務", market: "US", symbols: ["UNH", "CI", "ELV", "CVS", "HCA"] },
  { label: "銀行", market: "US", symbols: ["JPM", "BAC", "WFC", "C", "USB", "PNC", "TFC", "COF"] },
  { label: "投資銀行／資產管理", market: "US", symbols: ["GS", "MS", "SCHW", "BLK"] },
  { label: "支付／信用卡", market: "US", symbols: ["V", "MA", "AXP", "PYPL"] },
  { label: "保險", market: "US", symbols: ["MET", "PRU", "AIG"] },
  { label: "交易所／評等機構", market: "US", symbols: ["ICE", "CME", "SPGI", "MCO"] },
  { label: "工業機械／多角化工業", market: "US", symbols: ["GE", "CAT", "HON", "DE", "MMM", "ETN", "EMR", "ITW", "PH"] },
  { label: "航太／國防", market: "US", symbols: ["BA", "RTX", "LMT"] },
  { label: "物流／鐵路運輸", market: "US", symbols: ["UPS", "FDX", "UNP", "NSC", "CSX", "WM"] },
  { label: "石油天然氣", market: "US", symbols: ["XOM", "CVX", "COP", "SLB", "EOG", "PSX", "OXY", "WMB"] },
  { label: "公用事業／電力", market: "US", symbols: ["NEE", "DUK", "SO", "D", "AEP", "EXC", "SRE"] },
  { label: "不動產／REITs", market: "US", symbols: ["AMT", "PLD", "EQIX", "O", "SPG", "PSA"] },
  { label: "化工／工業氣體", market: "US", symbols: ["LIN", "SHW", "APD", "ECL"] },
  { label: "礦業／金屬", market: "US", symbols: ["NEM", "FCX"] },
];

interface IndexEntry {
  label: string;
  /** 在 FINE_INDUSTRY_GROUPS 裡的位置，直接當作排序時的族群先後。 */
  rank: number;
}

const INDEX: Map<string, IndexEntry> = (() => {
  const map = new Map<string, IndexEntry>();
  FINE_INDUSTRY_GROUPS.forEach((group, rank) => {
    for (const symbol of group.symbols) {
      const key = `${group.market}:${symbol.toUpperCase()}`;
      // 同一檔被不小心寫進兩組時，以先出現的那組為準（維持「一檔只屬於一組」
      // 的前提），不覆蓋、也不靜靜產生兩個不同的排序位置。
      if (!map.has(key)) map.set(key, { label: group.label, rank });
    }
  });
  return map;
})();

/** 已分類族群一律排在「其他」之前——所以「其他」的 rank 取一個必定最大的值。 */
const OTHER_RANK = Number.MAX_SAFE_INTEGER;

export interface FineIndustrySortable {
  symbol: string;
  market: Market;
  /** 交易所/資料源自己的官方產業別（例如「半導體業」「光電業」）。用來在這檔股票
   *  沒有被下面手動整理的細分族群收錄時，當一個「至少是真實分類」的退路——見
   *  fineIndustryOf() 的說明，不能沒有這個欄位就直接顯示「其他」。 */
  sector: string;
}

/**
 * 這檔股票的細分族群名稱。
 *
 * 2026-09-22 使用者反映：關注清單裡很多檔都顯示「其他」，要求要「明確標示細部是
 * 做什麼產業」。根因是這份細分表本來就刻意「只收關注清單裡實際比較可能出現的
 * 主流公司」（見檔案開頭說明），逐一手動擴充到涵蓋全台股近2000檔不切實際、也
 * 永遠會有漏網之魚。真正該修的不是硬擠更多股票進手動表，而是**退路不該是一個
 * 完全沒有資訊量的「其他」**——沒被這份表收錄的股票，退回顯示它在交易所自己
 * 資料裡真實的官方產業別（`sector`，例如「半導體業」「光電業」），這永遠存在
 * 且永遠是真的，只是顆粒度比手動整理的細分類粗一些，但比「其他」有意義得多。
 * 只有連官方產業別都是空字串（資料源本身缺這欄）才會真的顯示「其他」。
 */
export function fineIndustryOf(item: FineIndustrySortable): string {
  const curated = INDEX.get(`${item.market}:${item.symbol.toUpperCase()}`)?.label;
  if (curated) return curated;
  return item.sector.trim() || OTHER_FINE_INDUSTRY;
}

function rankOf(item: FineIndustrySortable): number {
  return INDEX.get(`${item.market}:${item.symbol.toUpperCase()}`)?.rank ?? OTHER_RANK;
}

/**
 * 依細分產業排序：先把同族群的排在一起（族群先後 = FINE_INDUSTRY_GROUPS 的
 * 順序，未分類的「其他」永遠墊底），同族群內再依代號由小到大。
 *
 * 次要排序刻意用「代號」而不是漲跌幅之類的即時數字：關注清單每 20 秒重抓一次
 * 報價，用會一直變動的數字當次要鍵會讓同族群內的股票在使用者眼前跳來跳去；
 * 代號是固定的，每次排出來都一樣，使用者看習慣的相對位置不會自己跑掉。
 */
export function compareByFineIndustry(a: FineIndustrySortable, b: FineIndustrySortable): number {
  const rankDiff = rankOf(a) - rankOf(b);
  if (rankDiff !== 0) return rankDiff;
  return a.symbol.localeCompare(b.symbol, "en");
}

export function sortByFineIndustry<T extends FineIndustrySortable>(items: T[]): T[] {
  return [...items].sort(compareByFineIndustry);
}
