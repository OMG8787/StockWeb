// 開放／一般題題組（2026-10-07 使用者🛠 02:18：「問一些基本問題反而沒辦法像一般AI一樣回答，常常過於死板，甚至與問題本身無關」）。
// 純資料；跑法：npx tsx scripts/eval/run.ts --tag 開放題 …；根因分析見 docs/eval/2026-10-07-open-questions.md。
import type { ChatTurn } from "@/lib/ai/types";
import type { CheckSpec, EvalCase } from "./types";

const AMD_HISTORY: ChatTurn[] = [
  { role: "user", content: "AMD 可以買嗎?" },
  {
    role: "assistant",
    content:
      "建議先不要買。\n\nAdvanced Micro Devices, Inc.(AMD)近1個月漲幅達 37.1%，RSI 84 進入超買區，本益比 167 倍偏高，未達本站買進門檻。",
  },
];
const WNC_HISTORY: ChatTurn[] = [
  { role: "user", content: "啟碁可以買嗎?" },
  {
    role: "assistant",
    content: "建議買進。\n\n啟碁(6285)8月營收年增率 81.21%、三大法人近5日買超，技術面站上20日均線；短線 RSI 78 偏高，宜分批。",
  },
];
const TSMC_HISTORY: ChatTurn[] = [
  { role: "user", content: "台積電最近走勢如何?" },
  { role: "assistant", content: "建議買進。\n\n台積電(2330)近1個月上漲、外資連買，站上20日與60日均線。" },
];

const MARKET_WORDS = ["加權", "大盤", "台股", "指數", "台指期", "期貨"];
const NO_STOCK_VERDICT: CheckSpec = { kind: "forbid", name: "不套個股買賣結論", any: ["建議先不要買", "建議買進", "未達本站買進門檻"] };
const DIRECTION: CheckSpec = {
  kind: "require",
  name: "明確給出漲跌看法",
  any: ["偏多", "偏空", "偏漲", "偏跌", "上漲", "下跌", "看漲", "看跌", "震盪", "會漲", "會跌", "收紅", "收黑"],
};
const NO_FAKE_PRICE: CheckSpec = { kind: "noUngroundedPrice" };
const NOT_MARKET_FIRST: CheckSpec = { kind: "forbid", name: "第一句不是大盤偏多／偏空", any: ["^\\s*偏多", "^\\s*偏空"] };

export const OPEN_QUESTION_CASES: EvalCase[] = [
  // ---------------- 使用者回報原題（4 則）
  {
    id: "open-taifex-after-amd",
    title: "上文聊 AMD，問台指期今天收盤漲跌：要答台指期／大盤，不可套 AMD 決策卡",
    question: "你覺得今天台指期收盤會漲還是跌",
    history: AMD_HISTORY,
    checks: [
      { kind: "forbid", name: "不扯上文個股 AMD", any: ["AMD", "Advanced Micro"] },
      NO_STOCK_VERDICT,
      { kind: "require", name: "談到台指期／大盤", any: MARKET_WORDS },
      DIRECTION,
      NO_FAKE_PRICE,
    ],
    source: "使用者📝 2026-10-07 01:12「你回答的跟我問的完全沒相關」",
    tags: ["open", "開放題", "大盤看法", "使用者原題"],
  },
  {
    id: "open-resilient-ctx-6285",
    title: "從啟碁個股頁問「抗壓性強且有上漲趨勢的股票」：要給全市場名單，不可只答啟碁",
    question: "有看起來抗壓性強且有上漲趨勢的股票嗎?",
    contextSymbol: "6285",
    history: WNC_HISTORY,
    checks: [
      { kind: "minSymbols", min: 2 },
      { kind: "require", name: "講抗壓／抗跌依據", any: ["抗壓", "抗跌", "回檔", "回撤", "大盤下跌", "波動"] },
      NO_FAKE_PRICE,
    ],
    source: "使用者📝 2026-10-07 02:12「這是因為前面都聊啟碁所以才又說啟碁嗎?」",
    tags: ["open", "開放題", "概念篩選", "使用者原題"],
  },
  {
    id: "open-resilient-hist",
    title: "上文聊啟碁（非個股頁），問「抗壓性強且有上漲趨勢的股票」：要列股票，不可答大盤偏多",
    question: "有看起來抗壓性強且有上漲趨勢的股票嗎?",
    history: WNC_HISTORY,
    checks: [{ kind: "minSymbols", min: 2 }, NOT_MARKET_FIRST, NO_FAKE_PRICE],
    source: "使用者📝 2026-10-07 02:14「沒回答到我的問題。」",
    tags: ["open", "開放題", "概念篩選", "使用者原題"],
  },
  {
    id: "open-resilient-plain",
    title: "沒有上文，問「抗壓性強且有上漲趨勢的股票」：要列股票且價格不可編",
    question: "有看起來抗壓性強且有上漲趨勢的股票嗎？",
    checks: [{ kind: "minSymbols", min: 2 }, NOT_MARKET_FIRST, NO_FAKE_PRICE],
    source: "使用者📝 2026-10-07 02:15（NVIDIA 編台積電 600 元、台光電 120 元）「回答與問題無關」",
    tags: ["open", "開放題", "概念篩選", "使用者原題"],
  },
  // ---------------- 大盤／台指期看法
  {
    id: "open-market-tomorrow",
    title: "明天台股會漲嗎：給方向與理由（指數、夜盤、法人、美股）",
    question: "明天台股會漲嗎？",
    checks: [DIRECTION, { kind: "require", name: "談到大盤資料", any: MARKET_WORDS }, NO_STOCK_VERDICT, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "大盤看法"],
  },
  {
    id: "open-why-drop",
    title: "今天台股為什麼跌（沒有上文）：用指數、法人、美股、新聞推理原因",
    question: "今天台股為什麼跌？",
    checks: [{ kind: "require", name: "談到大盤資料", any: MARKET_WORDS }, NO_STOCK_VERDICT, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "大盤看法"],
  },
  {
    id: "open-market-after-tsmc",
    title: "上文聊台積電，問「那大盤現在怎麼樣」：要答大盤，不可套台積電結論",
    question: "那大盤現在怎麼樣？",
    history: TSMC_HISTORY,
    checks: [{ kind: "require", name: "談到大盤資料", any: MARKET_WORDS }, NO_STOCK_VERDICT, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07（有上文個股時問無關的大盤題）",
    tags: ["open", "開放題", "大盤看法"],
  },
  {
    id: "open-us-why-up",
    title: "美股最近為什麼一直漲：用美股指數／總經推理",
    question: "美股最近為什麼一直漲？",
    checks: [
      { kind: "require", name: "談到美股指數", any: ["那斯達克", "S&P", "標普", "費城半導體", "道瓊", "美股"] },
      NO_STOCK_VERDICT,
      NO_FAKE_PRICE,
    ],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "大盤看法"],
  },
  {
    id: "open-fed-impact",
    title: "Fed 降息對台股的影響：總經推理題，不套個股結論",
    question: "Fed 降息對台股有什麼影響？",
    checks: [{ kind: "require", name: "談到利率", any: ["降息", "利率"] }, NO_STOCK_VERDICT, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "大盤看法"],
  },
  {
    id: "open-night-futures",
    title: "台指期夜盤現在多少：照資料回答，不可編點數",
    question: "台指期夜盤現在多少？",
    checks: [{ kind: "require", name: "談到夜盤", any: ["夜盤"] }, NO_STOCK_VERDICT, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "大盤看法"],
  },
  // ---------------- 概念篩選
  {
    id: "open-lowvol-yield",
    title: "低波動、高殖利率的股票：要列股票並附殖利率",
    question: "有低波動、高殖利率的股票嗎？",
    checks: [{ kind: "minSymbols", min: 2 }, { kind: "require", name: "附殖利率", any: ["殖利率"] }, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "概念篩選"],
  },
  {
    id: "open-uptrend-ma60",
    title: "多頭趨勢、站上季線的股票：要列股票",
    question: "最近有哪些股票是多頭趨勢、站上季線的？",
    checks: [{ kind: "minSymbols", min: 2 }, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "概念篩選"],
  },
  {
    id: "open-inst-buy-after-tsmc",
    title: "上文聊台積電，問「有沒有法人連續買超的股票」：全市場名單，不可只答台積電",
    question: "有沒有法人連續買超的股票？",
    history: TSMC_HISTORY,
    checks: [{ kind: "minSymbols", min: 2 }, NO_FAKE_PRICE],
    source: "開放題組 2026-10-07（有上文個股時問全市場篩選題）",
    tags: ["open", "開放題", "概念篩選"],
  },
  {
    id: "open-sector-compare",
    title: "半導體跟航運類股哪個比較強：類股比較，不可只答一檔",
    question: "半導體跟航運類股最近哪個比較強？",
    checks: [
      { kind: "require", name: "談到航運", any: ["航運"] },
      { kind: "require", name: "談到半導體", any: ["半導體"] },
      NO_STOCK_VERDICT,
      NO_FAKE_PRICE,
    ],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "類股比較"],
  },
  // ---------------- 名詞／純知識
  {
    id: "open-term-pe",
    title: "本益比是什麼、怎麼看高低：直接解釋，不可套個股結論",
    question: "本益比是什麼？怎麼看高低？",
    checks: [
      { kind: "require", name: "解釋本益比", any: ["股價.{0,6}(除以|÷|/).{0,6}(每股盈餘|EPS)", "幾年.{0,6}回本", "獲利"] },
      NO_STOCK_VERDICT,
      { kind: "length", min: 60, max: 600 },
    ],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "名詞知識"],
  },
  {
    id: "open-term-after-tsmc",
    title: "上文聊台積電，問「殖利率是什麼」：解釋名詞，不可改成台積電買賣判斷",
    question: "殖利率是什麼意思？",
    history: TSMC_HISTORY,
    checks: [
      { kind: "require", name: "解釋殖利率", any: ["股利.{0,8}(除以|÷|/|相對|佔).{0,6}股價", "配息.{0,10}股價", "現金股利"] },
      NO_STOCK_VERDICT,
      { kind: "length", min: 50, max: 600 },
    ],
    source: "開放題組 2026-10-07（有上文個股時問純知識題）",
    tags: ["open", "開放題", "名詞知識"],
  },
  {
    id: "open-etf-vs-stock",
    title: "ETF 跟個股差在哪、適合新手嗎：純知識題",
    question: "ETF 跟個股差在哪？新手適合哪一種？",
    checks: [{ kind: "require", name: "談到分散風險", any: ["分散", "一籃子", "多檔"] }, NO_STOCK_VERDICT, { kind: "length", min: 80, max: 650 }],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "名詞知識"],
  },
  {
    id: "open-defensive-style",
    title: "大盤震盪時適合買什麼類型的股票：一般投資知識＋現況",
    question: "大盤震盪的時候適合買什麼類型的股票？",
    checks: [
      { kind: "require", name: "講防禦型類別", any: ["防禦", "高股息", "民生", "電信", "低波動", "公用"] },
      NO_STOCK_VERDICT,
      NO_FAKE_PRICE,
    ],
    source: "開放題組 2026-10-07",
    tags: ["open", "開放題", "名詞知識"],
  },
];
