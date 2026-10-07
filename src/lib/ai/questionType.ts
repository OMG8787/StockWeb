/**
 * 「這題到底在問什麼」的唯一分類（2026-10-07 使用者🛠：「問一些基本問題反而沒辦法像一般AI一樣回答，常常過於死板，甚至與問題本身無關」）。
 *
 * 根因（docs/eval/2026-10-07-open-questions.md）：ask.ts 原本是一連串各自獨立的正則（targets／追問上文個股／wantsMovers／
 * wantsTechScreen／買賣判斷…），沒有任何一處先決定「題型」，於是：
 * - 「你覺得今天台指期收盤會漲還是跌」含「還是」被當成追問上文的 AMD、「會漲／會跌」又觸發買賣判斷 → 套 AMD 決策卡。
 * - 從啟碁個股頁問「有看起來抗壓性強且有上漲趨勢的股票嗎」→ contextSymbol 一律綁定啟碁，只答啟碁。
 * - 沒有對應資料的概念篩選（抗壓、上漲趨勢…）掉進「什麼都沒附」，加上「第一句給偏多／偏空」的格式規則 → 答成大盤偏多。
 *
 * 這裡先決定題型，ask.ts 的所有路由（要不要用個股頁／上文的股票、要不要附決策卡與買賣規則、附哪些全市場資料、
 * 組哪些提示詞規則）都看這一個結果。純函式、無 I/O（有測試 src/__tests__/questionType.test.ts）。
 * 刻意不用 AI 分類：每題多一次呼叫會吃免費額度與延遲；題型錯了寧可落到 "other"（維持原本行為），不會比改前差。
 */
import { isMethodQuestion, HOLDINGS_ANALYSIS_INTENT_PATTERN, LIST_REFERENCE_PATTERN } from "./intent";

export type QuestionType =
  /** 關注清單／持股分析（按鈕或明講分析我的持股） */
  | "holdings"
  /** 本站判斷方式（怎麼判斷、停損怎麼設） */
  | "method"
  /** 大盤／台指期／美股的漲跌看法、為什麼漲跌、總經影響——不套個股決策卡 */
  | "market-outlook"
  /** 本站沒有現成名單的概念篩選（抗壓、上漲趨勢、低波動、高殖利率…）——程式算條件出名單 */
  | "screen-concept"
  /** 名詞解釋／投資常識（本益比是什麼、ETF 跟個股差在哪）——可用一般金融知識回答，不套個股結論 */
  | "general-knowledge"
  /** 其他（個股題、全市場推薦、技術指標篩選、主題、新聞…）——沿用原本的路由 */
  | "other";

export type ScreenConcept = "resilient" | "uptrend" | "lowVol" | "highYield";

export const SCREEN_CONCEPT_LABEL: Record<ScreenConcept, string> = {
  resilient: "抗壓性強",
  uptrend: "上漲趨勢",
  lowVol: "低波動",
  highYield: "高殖利率",
};

const CONCEPT_PATTERNS: Record<ScreenConcept, RegExp> = {
  resilient: /抗壓|抗跌|防禦|跌不下去|逆勢|比大盤強|強於大盤|相對強勢|耐跌|跌得少/,
  uptrend: /上漲趨勢|上升趨勢|多頭趨勢|趨勢向上|趨勢往上|站上(?:季線|60日|六十日|月線|年線|均線)|走多|多頭格局|一路(?:漲|走高)|創新高/,
  lowVol: /低波動|波動(?:小|低|不大)|穩定的股票|穩健/,
  highYield: /高殖利率|殖利率(?:高|較高|好)|高股息|配息(?:高|多)|股利(?:高|多)/,
};

/** 問句提到的概念（依出現順序）。 */
export function detectScreenConcepts(question: string): ScreenConcept[] {
  return (Object.keys(CONCEPT_PATTERNS) as ScreenConcept[]).filter((k) => CONCEPT_PATTERNS[k].test(question));
}

/** 在要一份股票名單（不是問某一檔）。 */
const LIST_ASK_PATTERN = /股票|個股|標的|哪些|哪幾|哪[檔支]|有沒有|有哪|推薦|名單|清單|幾檔|類股|的嗎|的呢/;
/** 指代某一檔（這檔、它…）：有這種字眼時題目是在問那一檔，不是全市場。 */
export const STOCK_PRONOUN_PATTERN = /這[檔支隻家間]|那[檔支隻家間]|它|牠|該股|這個股|這間公司|第[一二三四五六七八九十\d]+[檔支個家只]/;
/** 技術指標字眼：有就交給既有的技術指標篩選（intent.ts conversationWantsTechScreen），不走概念篩選。 */
const TECH_WORD_PATTERN = /KD|MACD|RSI|黃金交叉|死亡交叉|金叉|死叉|布林|乖離|多頭排列|空頭排列/i;

/** 大盤層級的對象。 */
const MARKET_SUBJECT_PATTERN =
  /台指期|台指|期指|期貨|夜盤|大盤|加權|指數|台股|股市|美股|那斯達克|納斯達克|道瓊|標普|S&P|費半|費城半導體|盤勢|整體市場|市場氣氛|外資.{0,4}(?:動向|態度)/i;
/** 在問方向／原因／看法／影響。 */
const OUTLOOK_ASK_PATTERN =
  /漲|跌|多空|走勢|看法|怎麼看|如何|怎樣|怎麼樣|會不會|收紅|收黑|反彈|回檔|修正|崩|為什麼|為何|原因|影響|多少|現在|狀況|表現|情況|趨勢|方向|預測|展望/;
/** 總經題（Fed、降息、通膨、匯率…對市場的影響）。 */
const MACRO_TOPIC_PATTERN = /Fed|聯準會|FOMC|升息|降息|利率|通膨|CPI|非農|匯率|台幣|美元指數|景氣|衰退|關稅|戰爭|地緣政治|油價/i;

/** 名詞／常識題。 */
const DEFINITION_PATTERN =
  /是什麼|是甚麼|是啥|什麼意思|甚麼意思|的意思|定義|差在哪|差別|差異|區別|怎麼算|如何計算|怎麼計算|算法|公式|原理|怎麼看(?:高低|好壞)|新手|入門|適合(?:什麼|哪種|哪一種)類型|什麼類型|哪種類型|觀念|策略是|怎麼開始/;

export interface QuestionClassInput {
  question: string;
  /** 問句本身直接寫出的股票（guessSymbolsFromText 的結果數） */
  namedStockCount: number;
  /** 有沒有關注清單 */
  hasHoldings: boolean;
}

export interface QuestionClass {
  type: QuestionType;
  /** screen-concept 時的概念 */
  concepts: ScreenConcept[];
  /**
   * 可不可以把個股頁的 contextSymbol／上一則對話的股票當成這題的目標。
   * market-outlook／screen-concept／general-knowledge／method 且問句沒有指代詞時為 false。
   */
  useContextStock: boolean;
  /** 可不可以套「個股買賣判斷」（決策卡、第一句照抄評等、現價與把握程度補述）。只有個股題才可能為 true。 */
  allowStockJudgment: boolean;
}

/**
 * 唯一的題型分類。順序有意義：問句直接點名股票的一律是個股題（other，沿用原路由）；
 * 接著持股分析 → 方法 → 概念篩選 → 大盤看法 → 名詞常識。
 */
export function classifyQuestion(input: QuestionClassInput): QuestionClass {
  const q = input.question.trim();
  // 指代上文個股或上一則名單（這檔、這些、這3檔…）：題目是在問那幾檔，沿用原本的個股／名單路由。
  const pronoun = STOCK_PRONOUN_PATTERN.test(q) || LIST_REFERENCE_PATTERN.test(q);
  const make = (type: QuestionType, concepts: ScreenConcept[] = []): QuestionClass => {
    const nonStock = type === "market-outlook" || type === "screen-concept" || type === "general-knowledge" || type === "method";
    return {
      type,
      concepts,
      useContextStock: !(nonStock && !pronoun),
      allowStockJudgment: type === "other" || type === "holdings",
    };
  };
  if (input.namedStockCount > 0 || pronoun) {
    // 點名或指代個股：個股題（名詞題「台積電的本益比是什麼意思」也是在問這一檔）。
    return make("other");
  }
  if (input.hasHoldings && HOLDINGS_ANALYSIS_INTENT_PATTERN.test(q)) return make("holdings");
  if (isMethodQuestion(q)) return make("method");
  const concepts = detectScreenConcepts(q);
  if (concepts.length > 0 && LIST_ASK_PATTERN.test(q) && !TECH_WORD_PATTERN.test(q) && !MARKET_SUBJECT_PATTERN.test(q.replace(/類股/g, ""))) {
    return make("screen-concept", concepts);
  }
  if (DEFINITION_PATTERN.test(q) && !/推薦|哪些股票|哪幾檔|名單/.test(q)) return make("general-knowledge");
  if ((MARKET_SUBJECT_PATTERN.test(q) && OUTLOOK_ASK_PATTERN.test(q)) || (MACRO_TOPIC_PATTERN.test(q) && /影響|怎麼看|會不會|如何|衝擊|利多|利空|為什麼|為何|原因|嗎|呢/.test(q))) {
    // 「台股有哪些股票…」是全市場篩選，不是大盤看法。
    if (/哪些|哪幾|哪[檔支]|推薦|名單|股票有/.test(q) && !/台指期|夜盤|指數/.test(q)) return make("other");
    return make("market-outlook");
  }
  return make("other");
}
