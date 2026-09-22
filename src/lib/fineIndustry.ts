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

  // ── 台股：2026-09-22 大規模擴充（使用者要求「連沒收錄的也要細分」）──────
  // 上面這些是原本手動整理、只收關注清單常見主流股的部分；下面這一大段是
  // 額外用9個agent分頭比對全台股（上市約1094＋上櫃約891檔）裡當時還沒被
  // 收錄的~1743檔、憑各自對這些公司實際業務的知識歸類出來的結果，總共
  // 新增300組、涵蓋992檔。每個agent都被要求「不熟悉的公司寧可跳過、不要
  // 瞎猜」，所以扣掉這992檔之後剩下的股票會繼續退回官方粗分類（sector），
  // 這是正常結果，不是遺漏。跟上面手動整理的部分一樣，這是本站盡力而為的
  // 分類，不是官方權威分類，公司轉型/合併不會自動更新。
  { label: "PCB／印刷電路板", market: "TW", symbols: ["4958", "3715", "6672", "2316", "5439", "6141", "6191", "5469", "2328", "2355", "8147", "6155", "2460"] },
  { label: "電路板材料（CCL／銅箔基板／PI膜）", market: "TW", symbols: ["6274", "8039", "1815", "3645", "3354", "8358"] },
  { label: "連接器", market: "TW", symbols: ["3605", "3533", "6197", "6781", "6205", "3526", "6279", "3003", "4912", "3689", "5309", "6126", "3296", "6292", "5457", "6642", "3710", "6124", "6220", "8103", "6290", "7788", "3432"] },
  { label: "被動元件", market: "TW", symbols: ["3624", "6173", "5475", "2493", "2428", "6449", "2478", "6127", "6204", "6284", "6108", "6224"] },
  { label: "石英元件／振盪器", market: "TW", symbols: ["3042", "3511", "2484"] },
  { label: "電源供應器", market: "TW", symbols: ["8042", "6282", "3015", "2457", "3078", "6203", "3322", "8093", "8291", "3646"] },
  { label: "電腦週邊（滑鼠／相機模組）", market: "TW", symbols: ["2385", "4915"] },
  { label: "機殼／精密鈑金", market: "TW", symbols: ["2476", "2402", "2415", "3011"] },
  { label: "轉軸／機構件", market: "TW", symbols: ["3376", "1582", "3548", "3607"] },
  { label: "電池／電池材料", market: "TW", symbols: ["2472", "5227"] },
  { label: "測試探針", market: "TW", symbols: ["6217"] },
  { label: "導線架／電子構裝材料", market: "TW", symbols: ["4927"] },
  { label: "微動開關", market: "TW", symbols: ["2420"] },
  { label: "繼電器", market: "TW", symbols: ["2483"] },
  { label: "天線", market: "TW", symbols: ["3321"] },
  { label: "光通訊模組／光纖連接器", market: "TW", symbols: ["4943", "3501"] },
  { label: "變壓器", market: "TW", symbols: ["3207"] },
  { label: "車用LED／車燈", market: "TW", symbols: ["6432"] },
  { label: "LED照明", market: "TW", symbols: ["1471"] },
  { label: "光學鏡頭／相機模組", market: "TW", symbols: ["3294"] },
  { label: "散熱模組", market: "TW", symbols: ["3338", "4542"] },
  { label: "線材／電纜材料（電子用）", market: "TW", symbols: ["6134", "3631", "8038"] },
  { label: "PCB鑽針／耗材", market: "TW", symbols: ["3308"] },
  { label: "電線電纜", market: "TW", symbols: ["1605", "1609", "1617", "1608", "1623", "1611", "1618", "1612", "1615", "1616", "1603"] },
  { label: "家電", market: "TW", symbols: ["1604", "1614", "5283", "1626", "6275"] },
  { label: "化合物半導體代工（砷化鎵／功率放大器）", market: "TW", symbols: ["3105", "8086"] },
  { label: "矽晶圓／磊晶片", market: "TW", symbols: ["6182", "3016"] },
  { label: "探針卡／測試介面／測試耗材", market: "TW", symbols: ["6223", "6515", "3178", "8021"] },
  { label: "半導體測試設備（分選機／自動化設備）", market: "TW", symbols: ["7769", "6640", "5443", "3413"] },
  { label: "電子測試儀器／量測設備", market: "TW", symbols: ["2360", "3030", "2423"] },
  { label: "封測／先進封裝", market: "TW", symbols: ["3264", "6257", "8110", "3265", "2369", "2329", "6451", "3467", "6789"] },
  { label: "功率半導體／分立元件", market: "TW", symbols: ["2481", "5425", "3675", "2434", "2342", "8028"] },
  { label: "電源管理IC設計", market: "TW", symbols: ["6531", "6291", "6719", "6138", "8081", "8261", "2436", "8040", "3588", "5299", "6103"] },
  { label: "IC設計（通用邏輯／晶片組）", market: "TW", symbols: ["5274", "6526", "2363", "2388"] },
  { label: "MCU微控制器IC設計", market: "TW", symbols: ["4919", "6907", "3259"] },
  { label: "ASIC設計服務／矽智財", market: "TW", symbols: ["3035"] },
  { label: "記憶體（IC設計／控制器）", market: "TW", symbols: ["2337", "5351", "8054"] },
  { label: "記憶體模組", market: "TW", symbols: ["8271", "4973"] },
  { label: "觸控／生物辨識IC", market: "TW", symbols: ["2458", "6462", "3556", "3545"] },
  { label: "LED驅動IC", market: "TW", symbols: ["3527", "6485", "6129"] },
  { label: "顯示驅動IC", market: "TW", symbols: ["3592", "6962", "4961"] },
  { label: "光學感測IC（動作／影像／接近感測）", market: "TW", symbols: ["3227", "6732", "3530"] },
  { label: "類比IC／特殊功能IC設計", market: "TW", symbols: ["3438", "6411"] },
  { label: "IC設計（周邊連接控制晶片）", market: "TW", symbols: ["6104", "6756"] },
  { label: "IC設計（多媒體／消費性）", market: "TW", symbols: ["2401", "3041", "4952", "5236", "6494", "6237"] },
  { label: "晶圓代工／晶圓製造", market: "TW", symbols: ["5302"] },
  { label: "半導體材料／化學品／光罩", market: "TW", symbols: ["4749", "6937", "1785", "6698", "3305", "3663", "2338"] },
  { label: "半導體廠務工程（無塵室／氣體化學品供應系統）", market: "TW", symbols: ["6139", "5536", "2404", "6691", "6196", "6667", "6739"] },
  { label: "半導體材料分析／檢測認證服務", market: "TW", symbols: ["3289", "6830", "6146"] },
  { label: "自動化設備／機器人", market: "TW", symbols: ["2464", "4585", "2359", "6215", "6192", "3498", "6208"] },
  { label: "不斷電系統／電源供應器", market: "TW", symbols: ["3617", "3628", "4588", "6201"] },
  { label: "Micro LED", market: "TW", symbols: ["6854"] },
  { label: "感測元件（紅外線／車用）", market: "TW", symbols: ["3373", "3552"] },
  { label: "石英元件", market: "TW", symbols: ["3122"] },
  { label: "EMI濾波器／被動元件", market: "TW", symbols: ["6823"] },
  { label: "原料藥（API）代工製造", market: "TW", symbols: ["1789", "4119", "4102", "1762", "4129"] },
  { label: "學名藥／製藥廠", market: "TW", symbols: ["6620", "4105", "1720", "4114", "3705", "4167", "3716", "1734", "6461", "4111", "6838", "1752", "4120", "1731", "8432"] },
  { label: "新藥研發（生技新藥）", market: "TW", symbols: ["6919", "6885", "4743", "4162", "6875", "3176", "4128", "6785", "4157", "6492", "4168", "4108", "6576"] },
  { label: "生物相似藥／生技藥CDMO", market: "TW", symbols: ["6589", "6541", "4726"] },
  { label: "醫療器材（居家照護／生理監測）", market: "TW", symbols: ["4127", "4126", "4106", "4735", "4737", "1733", "4121", "4744"] },
  { label: "醫療器材（微創手術／骨科植入）", market: "TW", symbols: ["6499", "6934", "4163", "6733", "4109", "4153", "1781", "6767"] },
  { label: "生醫材料（玻尿酸／膠原蛋白）", market: "TW", symbols: ["1786", "4728", "6649"] },
  { label: "細胞治療／基因與幹細胞", market: "TW", symbols: ["6712", "1784", "4160", "6615"] },
  { label: "隱形眼鏡", market: "TW", symbols: ["6782", "3218", "1813", "3118"] },
  { label: "醫美／美容保養", market: "TW", symbols: ["4138", "4190", "6666", "4137", "6523"] },
  { label: "保健食品／機能性食品原料", market: "TW", symbols: ["8436", "3205", "6242", "8279", "3164"] },
  { label: "動物用藥", market: "TW", symbols: ["1777", "6496"] },
  { label: "醫療器材／藥品通路", market: "TW", symbols: ["6469", "4175", "8403", "4164", "4169", "6661", "4188"] },
  { label: "醫療影像／健康資訊科技", market: "TW", symbols: ["6841", "7803", "8409", "6637", "6569", "6796"] },
  { label: "血液透析／輸液醫療", market: "TW", symbols: ["4104", "1788", "1783"] },
  { label: "農業生技／生物農藥", market: "TW", symbols: ["6534", "6662"] },
  { label: "中醫醫療服務", market: "TW", symbols: ["4139"] },
  { label: "放射治療設備", market: "TW", symbols: ["7799"] },
  { label: "生技研究試劑／抗體", market: "TW", symbols: ["4133"] },
  { label: "塑化中游（可塑劑／塑膠原料）", market: "TW", symbols: ["1709", "1727", "1713", "4720", "1710", "4722"] },
  { label: "特用化學品（界面活性劑／清潔劑）", market: "TW", symbols: ["4764", "4739", "4716", "1732", "1730"] },
  { label: "染料／顏料／塗料", market: "TW", symbols: ["1711", "1726", "1735", "4711", "1725", "4755"] },
  { label: "電子化學品／半導體材料", market: "TW", symbols: ["4768", "1773", "4772", "6509", "4770", "4721"] },
  { label: "肥料／農藥", market: "TW", symbols: ["1722", "1712", "1776"] },
  { label: "接著劑／樹脂", market: "TW", symbols: ["1717", "4766"] },
  { label: "化學纖維", market: "TW", symbols: ["1718"] },
  { label: "無機化學（氯鹼工業）", market: "TW", symbols: ["1708"] },
  { label: "工業用油／蠟", market: "TW", symbols: ["4707", "1742"] },
  { label: "石化中間原料／精油", market: "TW", symbols: ["1714"] },
  { label: "LED磊晶／晶粒", market: "TW", symbols: ["2426", "4956", "3339", "3437"] },
  { label: "LED封裝", market: "TW", symbols: ["6168", "3031", "3050"] },
  { label: "LED照明／顯示應用", market: "TW", symbols: ["8111", "3591", "3230", "3297", "6167", "4972", "5220"] },
  { label: "太陽能電池／模組", market: "TW", symbols: ["6443", "4934"] },
  { label: "光電製程與檢測設備", market: "TW", symbols: ["8064", "3563", "3455", "6706", "3356"] },
  { label: "偏光板／光學膜材料", market: "TW", symbols: ["3051", "4960", "8215", "8240", "4933", "5230"] },
  { label: "光學鏡頭／鏡片", market: "TW", symbols: ["3441", "6209", "6668", "3362", "3019", "4976", "3630", "2374", "3504", "6517"] },
  { label: "觸控面板", market: "TW", symbols: ["3673", "3622", "3623"] },
  { label: "背光模組／導光板", market: "TW", symbols: ["6176", "3523", "3543"] },
  { label: "LCD面板／模組", market: "TW", symbols: ["8105", "8049"] },
  { label: "電視／顯示器品牌製造", market: "TW", symbols: ["2489"] },
  { label: "OLED微型顯示", market: "TW", symbols: ["8104"] },
  { label: "數位相機／攝影機模組／影像監控", market: "TW", symbols: ["3059", "6225", "2491", "5484"] },
  { label: "光通訊元件", market: "TW", symbols: ["5315", "2455", "4903", "7717", "6588"] },
  { label: "光碟片／儲存媒體", market: "TW", symbols: ["2349", "6128", "2323"] },
  { label: "伺服器／伺服器機殼", market: "TW", symbols: ["3693", "7711", "6933", "3013", "6928", "3349", "3706", "8210"] },
  { label: "工業電腦", market: "TW", symbols: ["6166", "3022", "3479", "3088", "6206", "6922", "8234", "3416", "2397", "3046", "2364"] },
  { label: "POS／條碼設備", market: "TW", symbols: ["8114", "3594", "8076", "3652", "3611"] },
  { label: "主機板／顯示卡", market: "TW", symbols: ["2399", "3515", "2331", "6150", "2465"] },
  { label: "掃描器／事務機", market: "TW", symbols: ["2305", "2380", "5438"] },
  { label: "電源供應器／電源轉換器", market: "TW", symbols: ["6278", "5392", "1569", "6117", "5258", "5490", "6591", "5356", "6276", "5215", "4931"] },
  { label: "鍵盤滑鼠週邊", market: "TW", symbols: ["8163", "2365", "2387"] },
  { label: "KVM／影音訊號切換設備", market: "TW", symbols: ["6277", "2417"] },
  { label: "機殼／散熱(PC)", market: "TW", symbols: ["3540", "3071"] },
  { label: "筆電機構件／零組件", market: "TW", symbols: ["4916", "5465", "3483", "6235", "3060", "3323"] },
  { label: "外接式儲存／NAS", market: "TW", symbols: ["2495", "8050", "3057"] },
  { label: "筆電代工(NB ODM)", market: "TW", symbols: ["2324", "2362"] },
  { label: "工具機", market: "TW", symbols: ["4526", "1583", "1530", "8107", "1541", "4513"] },
  { label: "滾珠螺桿／線性傳動元件", market: "TW", symbols: ["1597", "4540", "6609"] },
  { label: "精密減速機／齒輪", market: "TW", symbols: ["4571", "4583"] },
  { label: "氣動工具與元件", market: "TW", symbols: ["1527", "4564", "4562", "4555"] },
  { label: "電動工具代工零組件", market: "TW", symbols: ["1515", "1558", "5288"] },
  { label: "自行車零組件", market: "TW", symbols: ["1537", "4523", "4572", "4558"] },
  { label: "流體控制設備（泵浦／閥門／管件）", market: "TW", symbols: ["6982", "4580", "1535", "4510"] },
  { label: "電梯設備", market: "TW", symbols: ["4506"] },
  { label: "CNC控制器", market: "TW", symbols: ["7750"] },
  { label: "工業自動化零組件通路", market: "TW", symbols: ["8374"] },
  { label: "自動化設備／智慧停車", market: "TW", symbols: ["6125"] },
  { label: "工具機零組件（主軸／軸承）", market: "TW", symbols: ["8222"] },
  { label: "堆高機／搬運設備屬具", market: "TW", symbols: ["1540"] },
  { label: "農業機械", market: "TW", symbols: ["1517"] },
  { label: "工業儀器（流量計／液位計）", market: "TW", symbols: ["4549"] },
  { label: "鋁合金輪圈", market: "TW", symbols: ["1570"] },
  { label: "工業成型機（沖壓／射出／鍛造）", market: "TW", symbols: ["4533", "6603", "4528"] },
  { label: "精密工業馬達", market: "TW", symbols: ["4576", "1531"] },
  { label: "工業用輪／腳輪", market: "TW", symbols: ["1526"] },
  { label: "整車製造（汽車／機車）", market: "TW", symbols: ["2204", "2206", "1599", "2243"] },
  { label: "車燈", market: "TW", symbols: ["6605", "1522", "1521", "3717"] },
  { label: "車用電子零組件", market: "TW", symbols: ["2497", "8255"] },
  { label: "汽車零組件（鍛造／鑄造／加工）", market: "TW", symbols: ["1524", "1532", "1586", "4535", "2233"] },
  { label: "車用保桿／塑膠內外飾件", market: "TW", symbols: ["1319", "1338"] },
  { label: "雨刷系統", market: "TW", symbols: ["2239"] },
  { label: "汽車進口代理", market: "TW", symbols: ["2247"] },
  { label: "電動車平台／整車設計", market: "TW", symbols: ["2258"] },
  { label: "電動車馬達／驅動系統", market: "TW", symbols: ["1533", "2241", "4590"] },
  { label: "電動巴士／商用車", market: "TW", symbols: ["2237"] },
  { label: "精密螺絲／扣件", market: "TW", symbols: ["1587", "2067"] },
  { label: "工業用紙／包裝用紙", market: "TW", symbols: ["1904", "1909", "6790"] },
  { label: "文化用紙", market: "TW", symbols: ["1905", "1903"] },
  { label: "造紙控股集團", market: "TW", symbols: ["1907"] },
  { label: "玻璃／玻璃纖維", market: "TW", symbols: ["1802"] },
  { label: "衛浴設備", market: "TW", symbols: ["1810", "1817"] },
  { label: "建築陶瓷（磁磚／釉料）", market: "TW", symbols: ["1806", "1809"] },
  { label: "水泥製造", market: "TW", symbols: ["1104", "1110", "1103", "1108", "1109"] },
  { label: "輪胎製造", market: "TW", symbols: ["2105", "2101", "2102", "2106", "2104", "2109", "2107"] },
  { label: "合成橡膠／橡膠化學原料", market: "TW", symbols: ["2103", "2108", "6582"] },
  { label: "工業橡膠傳動製品", market: "TW", symbols: ["2114"] },
  { label: "建設開發（住宅營建）", market: "TW", symbols: ["4416", "1808", "2548", "6177", "2527", "2520", "5534", "2501", "5508", "2530", "2442", "2539", "2540", "5206", "2538", "5519", "2536", "2528", "5512", "5531", "2545", "2511", "2505", "2534", "2506", "2509", "2516", "4907", "2524", "5520", "1438", "3266", "6186", "5511", "2537", "3489", "3521"] },
  { label: "營造工程", market: "TW", symbols: ["2515", "2535", "2543", "5521", "2546"] },
  { label: "資產開發／都更", market: "TW", symbols: ["2547", "9946", "6171", "2923"] },
  { label: "觀光飯店", market: "TW", symbols: ["2704", "2739", "2722", "5704", "8077", "2748", "2702", "2706", "2736", "2712", "5703", "2701", "4806"] },
  { label: "旅行社／線上旅遊", market: "TW", symbols: ["2745", "2743", "2734", "2719", "6961"] },
  { label: "連鎖餐飲", market: "TW", symbols: ["2753", "2754", "7708", "1259", "2755", "3252", "2752", "7705", "7723", "2732", "1268", "7757", "2751", "7760"] },
  { label: "休閒育樂（樂園／KTV）", market: "TW", symbols: ["9943", "5701", "5905"] },
  { label: "百貨零售通路", market: "TW", symbols: ["2908", "2901", "2911", "2945", "2910", "8443"] },
  { label: "天然氣／瓦斯供應", market: "TW", symbols: ["9908", "8908", "9918", "9931", "8917", "9926"] },
  { label: "汽電共生發電", market: "TW", symbols: ["8926", "8931"] },
  { label: "油品物流／加油站", market: "TW", symbols: ["2616", "9937"] },
  { label: "網通設備", market: "TW", symbols: ["2332", "3062", "3596", "6416", "6245", "3047", "6674", "6263", "8011", "6142", "3447", "6216", "3672"] },
  { label: "RF／微波元件與天線", market: "TW", symbols: ["3491", "2485", "3138", "6546", "3152"] },
  { label: "衛星通訊與GPS定位", market: "TW", symbols: ["3025", "2314", "3499", "3632"] },
  { label: "無線通訊模組與元件", market: "TW", symbols: ["3694", "3664"] },
  { label: "網路儲存設備(NAS)", market: "TW", symbols: ["3558", "7805"] },
  { label: "資料中心與雲端服務", market: "TW", symbols: ["6561", "6870", "6997", "6112"] },
  { label: "資訊／通訊產品通路商", market: "TW", symbols: ["2450", "6776", "2414"] },
  { label: "系統整合", market: "TW", symbols: ["3147", "6140", "2480", "2453", "5410", "8099", "5403", "3158", "6614"] },
  { label: "資安服務與軟體代理", market: "TW", symbols: ["7765", "6690", "7823", "8416", "6123"] },
  { label: "ERP／企業軟體顧問", market: "TW", symbols: ["6590", "6752", "6697"] },
  { label: "金融資訊服務", market: "TW", symbols: ["7819", "8284"] },
  { label: "遊戲軟體／代理", market: "TW", symbols: ["6240", "4994", "3687"] },
  { label: "電商平台", market: "TW", symbols: ["8454", "8044", "6741", "7839", "8477", "3085"] },
  { label: "第三方支付", market: "TW", symbols: ["6763", "7722"] },
  { label: "家電3C通路", market: "TW", symbols: ["6281", "6154", "2430"] },
  { label: "IC通路商", market: "TW", symbols: ["3055", "3036", "8112", "6227", "3048", "3028", "3528"] },
  { label: "電子／半導體材料代理", market: "TW", symbols: ["3010", "5434"] },
  { label: "文件辨識／OCR軟體", market: "TW", symbols: ["5202", "5211"] },
  { label: "網路服務供應商", market: "TW", symbols: ["6163", "7547"] },
  { label: "人纖原料／聚酯加工絲", market: "TW", symbols: ["1409", "1434", "1447", "1455", "1466", "1444", "1418"] },
  { label: "紡紗業", market: "TW", symbols: ["1419", "1414", "1445"] },
  { label: "染整／織布", market: "TW", symbols: ["1410", "1446", "1463", "1452"] },
  { label: "成衣代工", market: "TW", symbols: ["1449", "1473", "4438", "4414"] },
  { label: "牛仔布／丹寧布", market: "TW", symbols: ["1451", "1459"] },
  { label: "機能性布料", market: "TW", symbols: ["4433", "1460"] },
  { label: "皮革／人工皮革製品", market: "TW", symbols: ["1457", "1413"] },
  { label: "發泡材料", market: "TW", symbols: ["1467"] },
  { label: "不織布", market: "TW", symbols: ["1474"] },
  { label: "毛紡呢絨", market: "TW", symbols: ["1423"] },
  { label: "西服成衣品牌", market: "TW", symbols: ["1417"] },
  { label: "太陽能發電／售電", market: "TW", symbols: ["6869", "6873", "6994", "7842", "8440", "6944"] },
  { label: "風力發電／離岸風電", market: "TW", symbols: ["2072", "7786", "3708"] },
  { label: "廢棄物處理", market: "TW", symbols: ["8422", "6803", "8341", "6951", "6771"] },
  { label: "水資源／污水處理", market: "TW", symbols: ["8473", "5205"] },
  { label: "環境工程／污染整治", market: "TW", symbols: ["8476", "9955"] },
  { label: "資源回收／再生", market: "TW", symbols: ["9930", "6947"] },
  { label: "電爐煉鋼／型鋼", market: "TW", symbols: ["2006", "2211", "2032"] },
  { label: "鋼鐵通路／加工中心", market: "TW", symbols: ["2031", "2010", "5011", "2022", "2007", "2012", "2030"] },
  { label: "特殊鋼／不鏽鋼棒線", market: "TW", symbols: ["5009", "2025", "2017", "8415", "2035"] },
  { label: "螺絲螺帽／緊固件", market: "TW", symbols: ["3004", "2065", "5014", "2028", "2063", "5538"] },
  { label: "鋼構工程", market: "TW", symbols: ["2033", "2013"] },
  { label: "銅材／銅棒", market: "TW", symbols: ["2009"] },
  { label: "鋼管", market: "TW", symbols: ["2020", "2008"] },
  { label: "鍍鋅鋼捲／表面處理", market: "TW", symbols: ["2029"] },
  { label: "汽車零組件／鍛造件", market: "TW", symbols: ["5016", "2073"] },
  { label: "食用油脂", market: "TW", symbols: ["1232", "1218", "1702", "1219", "1225", "1235", "1295"] },
  { label: "飲料／罐頭食品", market: "TW", symbols: ["1256", "1234", "7791", "1217"] },
  { label: "保健食品", market: "TW", symbols: ["7780", "1796"] },
  { label: "飼料／禽畜", market: "TW", symbols: ["1215"] },
  { label: "烘焙原料", market: "TW", symbols: ["1264"] },
  { label: "休閒食品／零食", market: "TW", symbols: ["1231"] },
  { label: "茶葉／茶飲", market: "TW", symbols: ["1233"] },
  { label: "巧克力／糖果", market: "TW", symbols: ["1236"] },
  { label: "調味料／速食", market: "TW", symbols: ["1203"] },
  { label: "廚衛設備", market: "TW", symbols: ["9911", "9934", "2062"] },
  { label: "窗簾製品", market: "TW", symbols: ["8464", "9935"] },
  { label: "門鎖五金", market: "TW", symbols: ["9924"] },
  { label: "家具／寢具", market: "TW", symbols: ["2938", "2916"] },
  { label: "家具製造與零售", market: "TW", symbols: ["8433", "4702", "6195", "6754"] },
  { label: "戶外用品", market: "TW", symbols: ["6728"] },
  { label: "寵物用品", market: "TW", symbols: ["6968"] },
  { label: "健身器材", market: "TW", symbols: ["4609", "1736", "1598"] },
  { label: "眼鏡零售", market: "TW", symbols: ["2937"] },
  { label: "五金零售", market: "TW", symbols: ["2947"] },
  { label: "生活雜貨零售", market: "TW", symbols: ["5904"] },
  { label: "控股／多角化投資", market: "TW", symbols: ["9945", "9907", "9902", "6901", "2514"] },
  { label: "租賃／汽車金融", market: "TW", symbols: ["5871", "6592", "9941", "7855"] },
  { label: "保全服務", market: "TW", symbols: ["9917", "9925"] },
  { label: "房仲／房地產代銷", market: "TW", symbols: ["2348", "9940"] },
  { label: "有線電視／系統業者", market: "TW", symbols: ["6184", "6464"] },
  { label: "紡織配件(織帶／魔鬼氈)", market: "TW", symbols: ["9938", "8404"] },
  { label: "衛生用品／醫療耗材(不織布)", market: "TW", symbols: ["6504", "9919"] },
  { label: "包裝容器(塑膠／PET)", market: "TW", symbols: ["9939"] },
  { label: "金屬包裝容器(製罐)", market: "TW", symbols: ["8411"] },
  { label: "紙包裝製品", market: "TW", symbols: ["8421"] },
  { label: "羽絨原料／寢具填充料", market: "TW", symbols: ["8916"] },
  { label: "工業密封元件(O-ring)", market: "TW", symbols: ["9942"] },
  { label: "隱形眼鏡代工", market: "TW", symbols: ["8442"] },
  { label: "電子零件通路", market: "TW", symbols: ["2496"] },
  { label: "工業氣體", market: "TW", symbols: ["6881"] },
  { label: "廢金屬資源回收", market: "TW", symbols: ["9927"] },
  { label: "消防設備工程", market: "TW", symbols: ["6904"] },
  { label: "服飾品牌經銷", market: "TW", symbols: ["2904"] },
  { label: "印刷", market: "TW", symbols: ["9929"] },
  { label: "教育／兒童文創用品", market: "TW", symbols: ["8489"] },
  { label: "生命禮儀服務", market: "TW", symbols: ["5530"] },
  { label: "電視媒體", market: "TW", symbols: ["9928"] },
  { label: "家具製造", market: "TW", symbols: ["8426"] },
  { label: "紡織／化纖上游", market: "TW", symbols: ["1437", "1416"] },
  { label: "自行車整車", market: "TW", symbols: ["9914", "9921"] },
  { label: "自行車零件", market: "TW", symbols: ["4536", "5306", "6890", "1593", "8924", "6768"] },
  { label: "高爾夫用品", market: "TW", symbols: ["8938", "9960"] },
  { label: "運動休閒場館經營", market: "TW", symbols: ["8462", "2762", "1432"] },
  { label: "遊艇製造", market: "TW", symbols: ["8478"] },
  { label: "製鞋代工", market: "TW", symbols: ["9802"] },
  { label: "水上運動用品", market: "TW", symbols: ["8467"] },
  { label: "線上遊戲／遊戲軟體", market: "TW", symbols: ["3546", "3086", "3083", "6169", "3629"] },
  { label: "影視內容／發行", market: "TW", symbols: ["8450", "6144"] },
  { label: "音樂／藝人經紀", market: "TW", symbols: ["8446"] },
  { label: "書店／文創零售", market: "TW", symbols: ["2926"] },
  { label: "出版", market: "TW", symbols: ["8923"] },
  { label: "表演藝術／售票", market: "TW", symbols: ["6596"] },
  { label: "工藝品", market: "TW", symbols: ["9949"] },
  { label: "娛樂科技設備", market: "TW", symbols: ["5263"] },
  { label: "IP角色授權", market: "TW", symbols: ["6101"] },
  { label: "銀行", market: "TW", symbols: ["5876", "2845", "2897", "2838", "2836", "2849"] },
  { label: "證券", market: "TW", symbols: ["5864", "6015", "6026", "6021", "6020"] },
  { label: "期貨", market: "TW", symbols: ["6023", "6024"] },
  { label: "產物保險", market: "TW", symbols: ["2850", "2816", "2832", "2852"] },
  { label: "票券金融", market: "TW", symbols: ["2820"] },
  { label: "再保險", market: "TW", symbols: ["2851"] },
  { label: "保險經紀代理", market: "TW", symbols: ["6028"] },
  { label: "金融控股(票券系)", market: "TW", symbols: ["2889"] },
  { label: "石化原料(泛用塑膠)", market: "TW", symbols: ["1312", "1313", "1304", "1310", "1309", "1305", "1308"] },
  { label: "人工皮革／合成皮", market: "TW", symbols: ["1307", "1315", "1321", "5450"] },
  { label: "保麗龍／發泡材料包材", market: "TW", symbols: ["1324", "1323"] },
  { label: "塑膠回收再生", market: "TW", symbols: ["1337"] },
  { label: "行李箱製造", market: "TW", symbols: ["9950"] },
  { label: "包裝膜／機能膜", market: "TW", symbols: ["4306"] },
  { label: "海運貨運承攬／船務代理", market: "TW", symbols: ["2641", "2611", "5609", "5603"] },
  { label: "貨櫃集散站", market: "TW", symbols: ["2613", "5601"] },
  { label: "造船", market: "TW", symbols: ["2208", "6753"] },
  { label: "散裝／油輪航運", market: "TW", symbols: ["2601", "2607", "2612"] },
  { label: "航空客運", market: "TW", symbols: ["2646", "6757"] },
  { label: "高鐵客運", market: "TW", symbols: ["2633"] },
  { label: "港埠經營", market: "TW", symbols: ["5607"] },
  { label: "航空維修／地勤", market: "TW", symbols: ["2630"] },
  { label: "陸運物流", market: "TW", symbols: ["5604", "1443", "2608"] },
  { label: "印表機／事務機代工", market: "TW", symbols: ["9105"] },
  { label: "精密機殼代工", market: "TW", symbols: ["9136"] },
  { label: "醫療耗材代工", market: "TW", symbols: ["9103"] },
  { label: "食品飲料", market: "TW", symbols: ["910322"] },
  { label: "汽車租賃", market: "TW", symbols: ["910861"] },
  { label: "塑膠家用品代工", market: "TW", symbols: ["911608"] },
  { label: "手機代工(ODM)", market: "TW", symbols: ["912000"] },
  { label: "動物疫苗／動物用藥", market: "TW", symbols: ["6508", "4171"] },
  { label: "飼料蛋白原料", market: "TW", symbols: ["6578"] },
  { label: "禽畜／蛋品", market: "TW", symbols: ["1240"] },
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
