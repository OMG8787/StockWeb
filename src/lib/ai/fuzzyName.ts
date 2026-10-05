/**
 * 台股名稱「近似比對」（純邏輯、無 I/O，有測試）。
 *
 * 2026-10-05 使用者回報：問「建鼎呢?」（打錯，應為健鼎 3044），回答「目前資料庫中沒有建鼎的相關資料」。
 * 使用者要的是：不確定是哪檔時先猜最可能的那檔直接分析，同時問「你是指健鼎(3044)嗎？」。
 *
 * 只在「完全比對不到任何股票」時才用（ask.ts 決定），而且只看問句開頭的「主詞」（去掉「那／請問」等開頭、
 * 遇到「呢／嗎／現在／能／的…」就截斷），不會掃整句——掃整句會把「明天」「台股」這種一般詞誤判成
 * 一字之差的公司（明泰、台塑…）。誤判防線：
 *  1. 2 個字的主詞：不同的那個字必須是常見同音／近形誤植（CONFUSABLE_GROUPS），例如 建↔健、每↔海。
 *  2. 3 個字以上：一字之差即可（同音近形分數較高）；或多／少一個字（例如「台積」→ 台積電）。
 *  3. 主詞本身在 FUZZY_SUBJECT_STOPWORDS（一般詞）就不比對（沿用 universe.ts AMBIGUOUS_CN_NAME_STOPWORDS 的思路）。
 */

export interface FuzzyCandidate {
  symbol: string;
  name: string;
}

export interface FuzzyNameGuess<T extends FuzzyCandidate = FuzzyCandidate> {
  /** 使用者打的字（主詞） */
  typed: string;
  best: T;
  /** 其他可能（最多 FUZZY_MAX_ALTERNATIVES 檔） */
  alternatives: T[];
}

/** 分數上限：超過就不算近似（0＝同音近形一字之差、1＝少打最後一字（台積→台積電）、1.5＝一般一字之差、2＝其他多／少一字）。 */
export const FUZZY_MAX_SCORE = 2;
export const FUZZY_MAX_ALTERNATIVES = 2;
/** 主詞長度範圍（台股簡稱多為 2～4 字）。 */
const SUBJECT_MIN_LEN = 2;
const SUBJECT_MAX_LEN = 5;

/** 常見同音／近形誤植（注音輸入選錯字、字形相近）。同一組內任兩字視為可互相誤植。 */
export const CONFUSABLE_GROUPS: readonly string[] = [
  "建健鍵見件",
  "機積基雞績",
  "每海梅",
  "鴻宏洪紅",
  "聯連蓮",
  "達答",
  "台臺抬",
  "電店殿",
  "碩朔",
  "廣光",
  "群裙",
  "揚陽楊洋",
  "緯偉維為",
  "晶精經京",
  "準准",
  "欣新心鑫",
  "興星",
  "茂貿",
  "鼎頂",
  "創窗",
  "億益義亿",
  "誠成承城",
  "豐風峰",
  "祥詳翔",
  "盛勝聖",
  "冠觀關",
  "碁基",
  "泰太",
  "亞雅",
  "嘉佳家",
  "鋼剛綱",
  "華化",
  "群郡",
  "智志",
  "凱楷",
  "穎影",
  "瑞睿",
  "譜普",
  "崴威",
  "富福",
  "邦幫",
  "微維",
  "騰藤",
  "訊迅",
];

const CONFUSABLE = new Map<string, Set<string>>();
for (const g of CONFUSABLE_GROUPS) {
  for (const c of g) {
    const set = CONFUSABLE.get(c) ?? new Set<string>();
    for (const d of g) if (d !== c) set.add(d);
    CONFUSABLE.set(c, set);
  }
}

const isConfusable = (a: string, b: string) => CONFUSABLE.get(a)?.has(b) ?? false;

/** 一般詞，即使跟某檔公司一字之差也不當成打錯的股名。 */
export const FUZZY_SUBJECT_STOPWORDS = new Set([
  "明天", "今天", "昨天", "後天", "現在", "目前", "最近", "大盤", "台股", "美股", "股票", "個股", "加權", "指數",
  "那個", "這個", "這檔", "那檔", "哪檔", "什麼", "甚麼", "為什麼", "怎麼", "可以", "建議", "推薦", "大家", "我們",
  "你們", "請問", "謝謝", "持股", "清單", "關注", "技術", "籌碼", "基本", "財報", "營收", "法人", "外資", "投信",
]);

/** 開頭的語助／發語詞。 */
const LEADING_FILLER = /^(?:那麼|那|請問一下|請問|問一下|我想問|想問|再問|還有|然後|所以|那你說|你覺得|幫我看|幫我查|查一下|看一下)\s*/;
/** 主詞到這些字就結束。 */
const SUBJECT_END = /呢|嗎|吗|的|現在|现在|能|可以|可不可以|怎麼|怎么|如何|股價|股价|目前|今天|明天|適合|适合|還|还|會|会|走勢|走势|要|該|该|是|有|在|跟|和|與|与|值得|多少|好不好|買|买|賣|卖|分析|評等|評價|呀|啊|吧|[?？!！,，。、\s]/;

/** 取出問句開頭的主詞（只含中文字）；取不到回 null。 */
export function extractSubject(question: string): string | null {
  let q = question.trim().replace(LEADING_FILLER, "");
  q = q.replace(LEADING_FILLER, "");
  const m = SUBJECT_END.exec(q);
  const subject = (m ? q.slice(0, m.index) : q).trim();
  if (!/^[一-鿿]+$/.test(subject)) return null;
  if (subject.length < SUBJECT_MIN_LEN || subject.length > SUBJECT_MAX_LEN) return null;
  if (FUZZY_SUBJECT_STOPWORDS.has(subject)) return null;
  return subject;
}

/** 名稱去掉「*」「-KY」等標記。 */
export function plainTwName(name: string): string {
  return name.replace(/[*＊]/g, "").replace(/-?KY$/i, "").trim();
}

/** 兩個字串的近似分數（越小越像）；不算近似回 null。 */
export function fuzzyScore(typed: string, name: string): number | null {
  if (typed === name) return null; // 完全相同不是「打錯」，交給一般比對
  if (typed.length === name.length) {
    const diffs: number[] = [];
    for (let i = 0; i < typed.length; i++) if (typed[i] !== name[i]) diffs.push(i);
    if (diffs.length !== 1) return null;
    const i = diffs[0];
    if (isConfusable(typed[i], name[i])) return 0;
    return typed.length >= 3 ? 1.5 : null;
  }
  // 多／少一個字：短的那個要 ≥2 字、而且是長的那個刪掉一個字（例如 台積→台積電、聯發科技→聯發科）
  const [short, long] = typed.length < name.length ? [typed, name] : [name, typed];
  if (long.length - short.length !== 1 || short.length < 2) return null;
  if (long === name && name.startsWith(typed)) return 1;
  for (let i = 0; i < long.length; i++) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return 2;
  }
  return null;
}

/**
 * 從候選清單（依熱門程度排序：越前面越常被查）挑最可能的一檔＋最多 FUZZY_MAX_ALTERNATIVES 個其他可能。
 * 排序：分數低者優先，同分依清單順序。
 */
export function guessByFuzzyName<T extends FuzzyCandidate>(question: string, candidates: readonly T[]): FuzzyNameGuess<T> | null {
  const typed = extractSubject(question);
  if (!typed) return null;
  const scored: Array<{ c: T; score: number; i: number }> = [];
  const seen = new Set<string>();
  candidates.forEach((c, i) => {
    if (seen.has(c.symbol)) return;
    const name = plainTwName(c.name);
    if (name === typed) return;
    const score = fuzzyScore(typed, name);
    if (score == null || score > FUZZY_MAX_SCORE) return;
    seen.add(c.symbol);
    scored.push({ c, score, i });
  });
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return { typed, best: scored[0].c, alternatives: scored.slice(1, 1 + FUZZY_MAX_ALTERNATIVES).map((s) => s.c) };
}

/** 給 AI 的內部標記：開頭先確認、再以猜到的那檔回答。 */
export function describeFuzzyGuess(g: FuzzyNameGuess): string {
  const alt = g.alternatives.length > 0 ? `（其他可能：${g.alternatives.map((a) => `${plainTwName(a.name)}(${a.symbol})`).join("、")}）` : "";
  return `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】名稱近似比對：使用者輸入的「${g.typed}」在本站股票清單查無完全相符的名稱，最可能是 ${plainTwName(g.best.name)}(${g.best.symbol})${alt}，下方個股資料就是這一檔。回答第一句必須寫「你是指${plainTwName(g.best.name)}(${g.best.symbol})嗎？以下以${plainTwName(g.best.name)}回答」，接著照常完整分析這一檔；不可說查無資料或資料庫沒有。`;
}
