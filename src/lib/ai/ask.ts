import { findInUniverse, getIndices, getMacroSnapshot, getTaifexNightFutures } from "@/lib/data";
import { buildMarketOverviewText } from "./marketOverview";
import type { Market } from "@/lib/data";
import { fetchIntlMarketNews, fetchNews, fetchUsMarketNews } from "@/lib/data/news";
import { formatTopicNewsBlock, searchTopicNews } from "@/lib/data/topicNews";
import { callAiProviders, type CallAiProvidersOptions } from "@/lib/ai/provider";
import { getNewsFeed } from "@/lib/ai/newsfeed";
import { getActionBrief, type ActionBrief } from "@/lib/ai/actionBrief";
import { getTradingStance } from "./tradingStance";
import { confidenceRank, describeConfidenceGrades, describeSiteRating, isRecommendable, stripRatingTags, TAKE_PROFIT_PEAK_GAIN_PCT } from "./siteRating";
import { HOLDING_STOP_MAX_PCT } from "./holdingStop";
import { QUALIFY_MAX_AGAINST, QUALIFY_MIN_SUPPORT } from "./actionScoring";
import { getStockRatings, type StockRatingResult } from "./stockRating";
import { isNearTaiexFuturesSettlement } from "@/lib/marketCalendar";
import type { ChatTurn } from "@/lib/ai/types";
import type { AskResult, HoldingInput } from "./askTypes";
import { guessSymbolByFuzzyName, guessSymbolsFromText } from "./symbolResolve";
import { describeFuzzyGuess } from "./fuzzyName";
import { describeRatingChanges, ensureRatingChangeExplained } from "./ratingChange";
import { ensureMarginSignalMentioned } from "./marginSignal";
import { ensureStockFactsMentioned } from "./stockFactsMention";
import { ensureChipsDateMentioned } from "./chipsDateMention";
import { getStockRating } from "./stockRating";
import {
  conversationWantsMovers,
  conversationWantsTechScreen,
  detectHistoryPeriod,
  extractTopicNewsQuery,
  wantsMarketWideBuyIdea,
  resolveFollowupTargets,
  isBareTradeYesNoQuestion,
  isMethodQuestion,
  isListReferenceQuestion,
  resolveListReferenceTargets,
  HOLDINGS_ANALYSIS_INTENT_PATTERN,
  HOLDINGS_TOPIC_PATTERN,
  HOLDINGS_DECISION_PATTERN,
  JUDGMENT_QUESTION_PATTERN,
  DEEPER_ANALYSIS_REQUEST_PATTERN,
  SINGLE_STOCK_ANALYSIS_INTENT_PATTERN,
  TECH_INDICATOR_PATTERN,
} from "./intent";
import { buildStockGrounding } from "./grounding/stock";
import { buildMarketPulseGrounding, buildMoversGrounding } from "./grounding/movers";
import { answerCardIssues, ensureFuzzyConfirmation, looksTruncated, pickForComparison, renderCardFallback, TRUNCATION_ISSUE_PREFIX } from "./decisionCard";
import { stripNameMarkersInText } from "./fuzzyName";
import { MARKET_JUDGMENT_PATTERN } from "./askSystemCompose";
import { isTaipeiWeekend } from "@/lib/marketStatus";
import { buildTechScreenGrounding } from "./grounding/techScreen";
import { buildConceptScreenGrounding } from "./grounding/conceptScreen";
import { classifyQuestion } from "./questionType";
import { buildHoldingsAnalysisGrounding, buildHoldingsGrounding } from "./grounding/holdings";
import { buildSectorCompareGrounding, buildThemeGrounding, detectSectorThemes, detectTheme, THEME_QUESTION_PATTERN } from "./grounding/theme";
import { buildCannedAnswer, sanitizeLeakedMarkers } from "./askFallback";
import { composeAskSystemPrompt } from "./askSystemCompose";
import { getMarketStatus } from "@/lib/marketStatus";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { findUngroundedPrices, guardAnswerNumbers, stripUngroundedPriceSentences, ungroundedPriceIssues, UNGROUNDED_PRICE_ISSUE_PREFIX } from "./numberGuard";
import { guardAvoidPriceAdvice, guardHeldAnswer, guardHoldingsCoverage } from "./ratingConsistencyGuard";
import { modelInfo } from "./modelName";

// `@/lib/ai/ask` 的公開介面刻意保持不變：這兩個型別原本就宣告在這個檔案裡，
// 拆檔之後搬到 askTypes.ts，這裡再原樣匯出，呼叫端（api/ask/route.ts）完全
// 不用改。
export type { AskResult, HoldingInput };

/** 台北今天（年月日數字）——一律由 pollingSchedule.ts 的 taipeiDayKey 推得（全站唯一的台北日期來源）。 */
function taipeiTodayForAsk(): { year: number; month: number; day: number } {
  const [year, month, day] = taipeiDayKey().split("-").map((n) => parseInt(n, 10));
  return { year, month, day };
}

/** 方法／原則題的程式說明（數字來自唯一來源常數；AI 照這套講，不可另編規則、不可改答某一檔）。 */
const METHOD_QUESTION_NOTE = `【本站判斷方式（方法題：直接用下列方式完整回答，不可反問使用者要查哪一檔、不可改成分析某一檔、不可點名任何個股）】
- 每檔每天用五個面向（技術、籌碼、持股結構、基本、財報）重算本站綜合評等；持有中的結論只有一個動作：續抱、可分批加碼、建議減碼、建議出場。
- 買進門檻（未持有）：支持面向至少 ${QUALIFY_MIN_SUPPORT} 項、不支持最多 ${QUALIFY_MAX_AGAINST} 項，且籌碼面不是不支持（三大法人賣超）、技術面不是不支持（空方訊號多於多方，一票否決）；過了就是「建議買進」，沒過就是「建議先不要買」並列出改判條件。
- 把握程度（只對建議買進）：大盤不偏弱且已連續 3 個交易日以上建議買進＝高；大盤偏弱且剛轉建議買進＝低；其餘＝中。
- 評等改變要連續 2 個交易日都成立才改判（避免一天的雜訊來回翻）；跌破停損價則立即生效。
- 停損：持有中出場參考價取近端支撐（均線／近 10 日低），離現價最多約 ${Math.round(HOLDING_STOP_MAX_PCT * 100)}%、且高於跌停價；收盤跌破就出場。
- 停利：買進後曾獲利 ${TAKE_PROFIT_PEAK_GAIN_PCT}% 以上、之後跌回成本以下 → 建議減碼（需填買進日期才判斷）；獲利中用移動停利價，收盤跌破就出場、守住獲利。
- 想看某一檔現在該放著還是出場，請問「XX 要續抱還是賣?」或在關注清單填成本與股數後按分析。`;

const METHOD_ANSWER_PATTERN = /連續 ?2 ?個交易日|停損|出場參考|支持面向|門檻/;

export async function answerQuestion(
  question: string,
  contextSymbol?: string,
  history: ChatTurn[] = [],
  holdings: HoldingInput[] = []
): Promise<AskResult> {
  // 「有把握程度高的推薦（股票）嗎」：問的是全市場分級，就算是從個股頁開的對話也不綁在那一檔
  // （2026-10-06 13:28 使用者回報：在鼎元頁追問高把握推薦，回答只講鼎元、還自己寫把握程度中）。
  const asksHighConfidence = HIGH_CONFIDENCE_QUESTION_PATTERN.test(question);
  const asksHighConfidenceList = asksHighConfidence && HIGH_CONFIDENCE_LIST_PATTERN.test(question) && !THIS_STOCK_PATTERN.test(question);
  const namedInQuestion = await guessSymbolsFromText(question);
  // 題型（唯一來源 questionType.ts）：決定能不能沿用個股頁／上文的股票、能不能套個股買賣判斷、附哪些全市場資料。
  // 2026-10-07 使用者回報：問台指期被答成上文 AMD 的決策卡；從啟碁頁問「抗壓性強的股票」只答啟碁。
  const qc = classifyQuestion({ question, namedStockCount: namedInQuestion.length, hasHoldings: holdings.length > 0 });
  // 上文／個股頁的股票只在「個股類」題型才當目標（other＝沿用原本路由）。
  const stockScoped = qc.useContextStock;
  let targets: Array<{ symbol: string; market: Market | undefined }> =
    contextSymbol && stockScoped && !(asksHighConfidenceList && namedInQuestion.length === 0)
      ? [{ symbol: contextSymbol, market: undefined as Market | undefined }]
      : contextSymbol
        ? []
        : namedInQuestion;
  // 「建議買嗎」「可以買嗎」這種沒指名對象的買賣是非題：對話裡有正在談的個股就是在追問那一檔，
  // 必須在 wantsMovers／全市場推薦判斷之前先找回來（2026-10-04 使用者回報的跳題）。
  // 方法／原則題不套用上一則的股票（見 intent.ts isMethodQuestion）。
  const methodQuestion = isMethodQuestion(question);
  if (targets.length === 0 && history.length > 0 && stockScoped && !methodQuestion && isBareTradeYesNoQuestion(question)) {
    targets = await resolveFollowupTargets(question, history);
  }
  // 「這幾檔／這些／名單裡有你看好的嗎」：指上一則 AI 回答列出的整份清單（2026-10-05 使用者回報
  // 跑出清單外的台積電）。要在全市場推薦判斷之前攔下，否則「幾檔」會被當成「推薦幾檔」。
  let listReference = false;
  if (targets.length === 0 && history.length > 0 && isListReferenceQuestion(question)) {
    const listTargets = await resolveListReferenceTargets(history);
    if (listTargets.length > 0) {
      targets = listTargets;
      listReference = true;
    }
  }
  // 主題新聞題（「今天有沒有 美國 伊朗的新聞」）：問句沒指到個股時，依主題即時搜尋新聞（lib/data/topicNews.ts）。
  // 2026-10-06 使用者回報：本站只有固定的台股／美股市場新聞，這類題目 AI 只能回「資料裡沒有」。
  // 有主題時不走全市場焦點／技術篩選／追問找個股（「有哪些新聞」會被誤當成「推薦哪些股票」）；
  // 但錯字個股（「建鼎有什麼新聞」）仍會在下面的模糊比對猜到一檔，猜到就改走個股流程。
  // 大盤看法／概念篩選／名詞題由題型決定資料（questionType.ts），不走下面這些「沒指到個股時」的舊判斷。
  const genericRouting = qc.type === "other" || qc.type === "holdings";
  let topicNewsQuery = targets.length === 0 ? extractTopicNewsQuery(question) : null;
  // A themed request ("AI概念股有哪些") only makes sense to check when the
  // question didn't already resolve to specific stock(s) — "台積電是不是
  // AI概念股" should still ground 台積電 itself, not switch over to the
  // theme screen.
  const themeMatch = targets.length === 0 && genericRouting ? detectTheme(question) : undefined;
  // 問的是主題/概念股，但本站沒有這個主題的分類資料（見 THEME_QUESTION_PATTERN
  // 的說明）——這種情況要明講，不能讓 AI 拿一般的今日焦點清單冒充成該主題的成分股。
  const unknownTheme = targets.length === 0 && genericRouting && !themeMatch && THEME_QUESTION_PATTERN.test(question);
  // 錯字（「建鼎呢?」→ 健鼎）：問句本身沒有篩選字眼、只是因為上一句問過「可以買嗎」才被當成延續全市場焦點時，
  // 先試名稱近似比對——問句有一個近似股名的主詞，比「沿用上一句的全市場意圖」更可信（2026-10-06 評測 typo-name）。
  let fuzzyNote = "";
  const moversOnlyByHistory =
    targets.length === 0 && !themeMatch && !topicNewsQuery && !conversationWantsMovers(question, []) && conversationWantsMovers(question, history);
  if (!contextSymbol && genericRouting && moversOnlyByHistory) {
    const guess = await guessSymbolByFuzzyName(question).catch(() => null);
    if (guess) {
      targets = [{ symbol: guess.best.symbol, market: guess.best.market }];
      fuzzyNote = describeFuzzyGuess(guess);
    }
  }
  // 概念篩選題：問句本身有排行字眼（法人買超、殖利率…）才另附漲幅／排行資料，不看上文。
  const wantsMovers =
    targets.length === 0 &&
    !themeMatch &&
    !topicNewsQuery &&
    (genericRouting ? conversationWantsMovers(question, history) : qc.type === "screen-concept" && conversationWantsMovers(question, []));
  // 「用技術指標條件篩股票」跟上面的 wantsMovers 是兩個獨立的需求：問「有沒有
  // MACD跟KD都黃金交叉的股票」時需要的是全市場逐檔算過的指標明細，不是漲幅榜；
  // 反過來問「今天有哪些股票不錯」則不需要那份很長的指標表。兩者可以同時成立
  // （例如「有沒有均線多頭排列、適合明天買的股票」），各自附各自的資料。
  const wantsTechScreen = targets.length === 0 && genericRouting && !themeMatch && !topicNewsQuery && conversationWantsTechScreen(question, history);
  // 這一句沒寫出股票名稱、也不是主題/篩選問題，但看起來是在追問上文提過的某一檔
  // （「第一檔的本益比多少?」「這檔法人買超多少?」）——把那一檔從對話紀錄裡
  // 找回來當成目標，否則會完全沒有個股資料、誤答成「查不到這檔股票的資料」。
  // 刻意排在 themeMatch/wantsMovers/wantsTechScreen 之後判斷，確保全市場篩選類
  // 問題永遠優先，不會被誤解成在問某一檔。
  if (targets.length === 0 && stockScoped && !methodQuestion && !themeMatch && !unknownTheme && !wantsMovers && !wantsTechScreen && !topicNewsQuery && history.length > 0) {
    targets = await resolveFollowupTargets(question, history);
  }
  // 錯字（「建鼎呢?」→ 健鼎）：完全比對不到、也不是篩選／主題／追問時，猜最可能的一檔直接分析，
  // 並要求 AI 開頭先確認（2026-10-05 使用者回報直接回「資料庫中沒有建鼎」）。見 fuzzyName.ts。
  if (!contextSymbol && genericRouting && targets.length === 0 && !themeMatch && !unknownTheme && !wantsMovers && !wantsTechScreen && !methodQuestion) {
    const guess = await guessSymbolByFuzzyName(question).catch(() => null);
    if (guess) {
      targets = [{ symbol: guess.best.symbol, market: guess.best.market }];
      fuzzyNote = describeFuzzyGuess(guess);
      topicNewsQuery = null;
    }
  }
  const wantsHoldingsAnalysis = holdings.length > 0 && HOLDINGS_ANALYSIS_INTENT_PATTERN.test(question);
  // 開放式「建議買什麼」→ 範圍是全市場，見 intent.ts wantsMarketWideBuyIdea 的說明。
  const wantsMarketWide =
    targets.length === 0 &&
    !themeMatch &&
    !unknownTheme &&
    !topicNewsQuery &&
    !wantsHoldingsAnalysis &&
    genericRouting &&
    (wantsMarketWideBuyIdea(question) || asksHighConfidenceList);
  // 今日建議頁已經算好的全市場多面向買進候選（30分鐘快取，跟 /action 頁同一份，兩邊答案才會一致）；
  // 冷快取時最多等8秒，逾時就不附，不拖慢聊天回應。
  const actionBriefPromise: Promise<ActionBrief | null> = wantsMarketWide
    ? Promise.race([
        getActionBrief().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ])
    : Promise.resolve(null);
  const stance = getTradingStance();
  // The "問AI關於<股票>" button on every stock page pre-fills exactly this
  // phrasing (see ChatWidget.tsx's ASK_ABOUT_EVENT handler) — a user asked
  // for this button's answer to be as precise/thorough as the watchlist
  // deep-analysis feature, for every stock, not just ones being held.
  // Gated on contextSymbol (this button is the only thing that sets it) so
  // a narrower follow-up question in the same conversation — "殖利率多少"
  // — doesn't get inflated into a full write-up it didn't ask for.
  const wantsSingleStockAnalysis = !!contextSymbol && SINGLE_STOCK_ANALYSIS_INTENT_PATTERN.test(question);
  // 買賣判斷題（要不要買、走勢、何時進場、比較…；很短的追問看上一句）：個股資料最上面附程式組好的結論卡，
  // 回答後檢查第一句與結論卡一致（decisionCard.ts）。
  const lastUserForJudgment = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  // 只有個股題可以套（questionType.ts allowStockJudgment）：問台指期「會漲還是跌」不是個股買賣判斷。
  const tradeJudgment =
    qc.allowStockJudgment &&
    targets.length > 0 &&
    (wantsSingleStockAnalysis ||
    JUDGMENT_QUESTION_PATTERN.test(question) ||
    TRADE_JUDGMENT_EXTRA_PATTERN.test(question) ||
    (question.trim().length <= SHORT_FOLLOWUP_MAX_LEN && JUDGMENT_QUESTION_PATTERN.test(lastUserForJudgment)));
  // 大盤題（「今天大盤怎樣」「有什麼值得注意」）：附精簡漲跌榜，答得出今天的焦點（2026-10-06 評測）。
  const wantsMarketPulse =
    targets.length === 0 &&
    !themeMatch &&
    !unknownTheme &&
    !topicNewsQuery &&
    !wantsMovers &&
    !wantsTechScreen &&
    !wantsMarketWide &&
    (qc.type === "market-outlook" || MARKET_OVERVIEW_QUESTION_PATTERN.test(question));

  // 關注清單只在這一句（或上一句使用者的話）真的在談持股時，才附逐檔報價損益；否則
  // 只附一份「名單背景」（名稱＋代號，不抓報價）。2026-10-04 使用者反映 AI 聊著聊著
  // 跳題：只要使用者有關注清單，每一題都被塞進整份逐檔損益，加上 RULE_HOLDINGS_LIGHT
  // 要求「逐檔講重點」，模型就會在不相干的回答尾巴自己盤點起整份清單。
  // 正在討論的那一檔剛好是持股時，只附那一檔的那一行（成本損益一句話帶過用）。
  const lastUserTurn = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const holdingsTopical =
    wantsHoldingsAnalysis || HOLDINGS_TOPIC_PATTERN.test(question) || HOLDINGS_TOPIC_PATTERN.test(lastUserTurn);
  // 談持股且在做決策（賣哪些、要不要賣、停損停利…）：輕量清單也附每檔含成本的評等，跟深度分析同一套結論。
  const wantsHoldingsDecision = holdingsTopical && !wantsHoldingsAnalysis && HOLDINGS_DECISION_PATTERN.test(question);
  const targetSymbolSet = new Set(targets.map((t) => t.symbol.toUpperCase()));
  const holdingsForGrounding = holdingsTopical
    ? holdings
    : holdings.filter((h) => targetSymbolSet.has(h.symbol.toUpperCase()));
  const holdingsBackgroundNote =
    !holdingsTopical && holdings.length > 0
      ? `使用者的關注清單共 ${holdings.length} 檔：${holdings.map((h) => `${h.name}(${h.symbol})`).join("、")}。這題沒在問持股，除非使用者明確問到，否則不要提、不要盤點。`
      : "";

  let groundedSymbol: string | undefined;

  // Always ground with both markets' index levels (not just whichever
  // market the question is about), plus the specific stock's data when one
  // or more is targeted, so the model can reason about TW/US cross-market
  // influence (e.g. Nasdaq overnight moves affecting semiconductor names)
  // instead of only seeing one stock in isolation. General market news is
  // likewise always fetched (not just when a stock is targeted) — it's what
  // used to be missing entirely whenever someone asked about "資訊面"/總經
  // without naming a specific stock, which had no grounding path to attach
  // it to.
  const [
    stockGroundingResults,
    indexGrounding,
    moversGrounding,
    techScreenGrounding,
    themeGrounding,
    holdingsGrounding,
    marketNews,
    newsFeed,
    topicNews,
    marketPulse,
    indicesOnly,
    conceptText,
  ] =
    await Promise.all([
      // 問到過去某天/某段期間時，個股【歷史脈絡】多附該期間逐日明細；多檔比較時每檔歷史脈絡精簡版。
      Promise.all(
        targets.map((t) =>
          buildStockGrounding(t, {
            period: detectHistoryPeriod(question, taipeiTodayForAsk()),
            compact: targets.length > 1,
            // 評等紀錄的來源入口：個股頁「問AI關於」會帶 contextSymbol。
            source: contextSymbol && contextSymbol.toUpperCase() === t.symbol.toUpperCase() ? "stock-button" : "ai-ask",
            // AI 判斷層只在問 1～2 檔個股時呼叫（關注清單深度分析不走這裡，避免一次十幾檔吃免費額度）。
            aiJudge: targets.length <= 2,
            decisionCard: tradeJudgment,
            // 持有中那筆的購買價格與買進日（停利規則只看買進日之後的日K，沒有買進日就不觸發；見 siteRating.checkTakeProfit）。
            ...(({ costBasis, buyDate }) => ({ costBasis, buyDate }))(
              holdings.find((h) => h.symbol.toUpperCase() === t.symbol.toUpperCase() && (h.shares ?? 0) > 0) ?? ({} as Partial<HoldingInput>)
            ),
          })
        )
      ),
      Promise.all([getIndices(), getTaifexNightFutures().catch(() => null), getMacroSnapshot()])
        .then(([indices, taifexFutures, macro]) => buildMarketOverviewText(indices, taifexFutures, macro))
        .catch(() => ""),
      wantsMovers ? buildMoversGrounding() : Promise.resolve(""),
      wantsTechScreen
        ? buildTechScreenGrounding({ question, lastUserTurn: [...history].reverse().find((t) => t.role === "user")?.content }).catch(() => "")
        : Promise.resolve(""),
      // 兩個以上類股（「半導體跟航運哪個強」）：各類股的漲跌家數與加權漲跌由程式算好（theme.ts buildSectorCompareGrounding）。
      themeMatch
        ? detectSectorThemes(question).length >= 2
          ? Promise.all([buildSectorCompareGrounding(detectSectorThemes(question)), buildThemeGrounding(themeMatch)]).then((x) => x.filter(Boolean).join("\n\n"))
          : buildThemeGrounding(themeMatch)
        : Promise.resolve(""),
      (wantsHoldingsAnalysis
        ? buildHoldingsAnalysisGrounding(holdings)
        : buildHoldingsGrounding(holdingsForGrounding, TECH_INDICATOR_PATTERN.test(question), wantsHoldingsDecision)
      ).catch(() => ""),
      Promise.all([fetchNews("台股", 6), fetchUsMarketNews(5), fetchIntlMarketNews(5)]).catch(() => [[], [], []] as const),
      // Shares the same 20-minute cache as the /news page's AI classifier —
      // a near-free reuse of work already done there (which items are
      // genuinely market-moving, plus a one-line plain-language "what this
      // means" for each) rather than re-deriving importance from the raw
      // headlines below.
      getNewsFeed().catch(() => ({ pinned: [], items: [], generatedAt: "" })),
      // 主題新聞搜尋：搜尋失敗會標成「失敗」（不是「0 則」），模型才不會把沒搜到說成沒有新聞。
      topicNewsQuery ? searchTopicNews(topicNewsQuery) : Promise.resolve(null),
      wantsMarketPulse ? buildMarketPulseGrounding(isTaipeiWeekend() ? "最近一個交易日" : "今日") : Promise.resolve(""),
      // 聚焦用：買賣判斷題只附指數本身（getIndices 有快取，不多打上游）。
      getIndices()
        .then((indices) => indices.map((i) => `${i.name}：${i.price}（${i.change >= 0 ? "+" : ""}${i.changePercent}%）`).join("\n"))
        .catch(() => ""),
      // 概念篩選題（抗壓性強、上漲趨勢、低波動、高殖利率）：程式算條件出名單＋每檔本站評等（grounding/conceptScreen.ts）。
      qc.type === "screen-concept" ? buildConceptScreenGrounding(qc.concepts).catch(() => "") : Promise.resolve(""),
    ]);
  const topicNewsText = topicNews ? formatTopicNewsBlock(topicNews) : "";

  const actionBrief = await actionBriefPromise;
  const actionBriefText = actionBrief?.usedAi ? actionBrief.text : "";
  // 名單（哪幾檔）跟今日建議同一份；每檔的評等行一律用 describeSiteRating 讀「現在」的 stockRating（10 分鐘快取命中），
  // 跟個股頁「問AI關於」逐字相同（2026-10-06 整合稽核：原本這裡自己拼一份少了價位與改判條件的格式，且用今日建議快取裡的舊字樣）。
  const listRatings = actionBrief
    ? await getStockRatings(actionBrief.picks.map((p) => ({ symbol: p.symbol, market: "TW" as const })), undefined, "ai-ask").catch(
        () => new Map<string, StockRatingResult>()
      )
    : new Map<string, StockRatingResult>();
  // 某檔現在讀不到評等（批次逾時／上游失敗）時，沿用今日建議名單裡同一份評等的字樣，不可當成「沒有建議買進」
  // （2026-10-06 13:17 使用者回報：今日建議有 5 檔，AI 卻答「目前市場上沒有符合建議買進的股票」）。
  // 依本站把握程度高→低（今日建議名單本身已照這個排，這裡用即時評等再排一次，兩邊一致）。
  const listLines = actionBrief
    ? [...actionBrief.picks]
        .map((p, i) => ({ p, i, rank: listRatings.get(p.symbol.toUpperCase()) ? confidenceRank(listRatings.get(p.symbol.toUpperCase())!.rating) : 3 }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map((x) => x.p)
        .flatMap((p) => {
        const r = listRatings.get(p.symbol.toUpperCase());
        if (!r) return p.code !== "avoid" ? [`${p.name}(${p.symbol})：${p.label}${p.confidence ? `。${p.confidence}` : ""}`] : [];
        return isRecommendable(r.rating) ? [describeSiteRating(r.name, r.symbol, r.rating)] : [];
      })
    : [];
  const ratingListText = actionBrief
    ? listLines.length > 0
      ? `【建議買進（現價可分批買）】\n${listLines.join("\n")}`
      : "（本站綜合評等目前沒有任何一檔是「建議買進」）"
    : wantsMarketWide
      ? "（今日建議名單這次讀取逾時，不是沒有建議買進的股票：照實告訴使用者「名單暫時讀不到，請稍後再問一次或看今日建議頁」，不可說今天沒有推薦）"
      : "";

  const stockGroundings = stockGroundingResults.filter((g): g is { symbol: string; text: string } => g !== undefined);
  if (stockGroundings.length > 0) groundedSymbol = stockGroundings[0].symbol;
  // 問把握程度高的：程式分級（全市場名單＋這題提到的個股），AI 照這份回答，沒有高的就照實說。
  const confidenceGradesText = asksHighConfidence
    ? await Promise.all(stockGroundings.map((g) => getStockRating(g.symbol).catch(() => null)))
        .then((rs) =>
          describeConfidenceGrades([
            ...[...listRatings.values()].filter((r) => isRecommendable(r.rating)),
            ...rs.filter((r): r is StockRatingResult => r != null && !listRatings.has(r.symbol.toUpperCase())),
          ])
        )
        .catch(() => "")
    : "";
  // 聚焦 grounding：個股買賣判斷題、沒問到大盤時，只附指數本身（不附總經、市場歷史、夜盤、大盤重大事件），
  // 減少雜訊讓弱模型專心在結論卡與個股資料（2026-10-06「提高 Lite 下限」）。
  const focusedStock = tradeJudgment && stockGroundings.length > 0 && !MARKET_JUDGMENT_PATTERN.test(question);
  const indexText = focusedStock && indicesOnly ? indicesOnly : indexGrounding;
  // 比較題：「若只能選一檔選哪檔」由程式依評等決定（decisionCard.ts），AI 不用自己挑、也不會照抄規則範例。
  const comparisonText =
    stockGroundings.length >= 2 && COMPARISON_QUESTION_PATTERN.test(question)
      ? await Promise.all(stockGroundings.map((g) => getStockRating(g.symbol).catch(() => null)))
          .then(
            (rs) =>
              pickForComparison(
                rs.filter((r): r is StockRatingResult => r != null).map((r) => ({ name: r.name, symbol: r.symbol, rating: r.rating }))
              ) ?? ""
          )
          .catch(() => "")
      : "";
  // 評等跟前一交易日不同時，附原因讓 AI 主動交代（2026-10-06 使用者：「昨天你不是說南亞不要追高」）。見 ratingChange.ts。
  // 關注清單／持股題也附（2026-10-06 使用者：「昨天建議我賣我才賣、建議我買我才買，今天又不一樣」）：持有中的還比對已持有結論。
  const heldSymbols = new Set(
    holdings.filter((h) => h.costBasis != null && (h.shares ?? 0) > 0).map((h) => h.symbol.toUpperCase())
  );
  const ratingChangeText = await buildRatingChangeText(
    [
      ...stockGroundings.map((g) => g.symbol),
      ...(holdingsGrounding ? holdingsForGrounding.map((h) => h.symbol) : []),
      ...(actionBrief?.picks ?? []).map((p) => p.symbol),
    ],
    heldSymbols
  );
  // At least one candidate symbol was parsed out of the question but NONE
  // of them resolved to real data — the single-target case this already
  // handled before multi-symbol support existed. A PARTIAL miss (e.g.
  // "環球晶跟世界先進比較" when only one of the two is covered) is handled
  // differently below: the found stock's real 個股資料 block plus a small
  // named note about the specific one that wasn't found, not this generic
  // "nothing at all" note.
  const unresolvedTargets = targets.filter((t) => !stockGroundings.some((g) => g.symbol === t.symbol));
  // An Opus QA pass caught the model telling a user a TPEx stock "isn't
  // covered" during a real upstream outage window, when it actually is
  // covered — buildStockGrounding failing doesn't distinguish "this symbol
  // doesn't exist in our universe" from "it does, but the live fetch just
  // failed this moment" (most often a transient TPEx hiccup — see tpex.ts's
  // retry/resume logic, which reduces but doesn't eliminate that upstream's
  // own instability). findInUniverse still recognizes a known symbol even
  // when its live data fetch failed, so it's the signal used here to keep
  // those two cases worded honestly differently instead of conflating them.
  const unresolvedKnown = unresolvedTargets.filter((t) => findInUniverse(t.symbol, t.market));
  const unresolvedUnknown = unresolvedTargets.filter((t) => !findInUniverse(t.symbol, t.market));

  function describeUnresolved(): string {
    const parts: string[] = [];
    if (unresolvedKnown.length > 0) {
      // 這裡一定要把真實公司名稱一起附上（從本站自己的官方股票清單查，不是
      // 猜的），不能只給代號——之前只給代號時，模型會自己用訓練知識「猜」
      // 這個代號是哪家公司，猜錯就變成講出一個完全不存在或錯誤的公司名稱
      // 塞進去（實測踩到：5274/信驊被講成不存在的「宏觀電通」）。名稱不明
      // 時退回代號本身，至少不會講錯成別家公司。
      parts.push(
        `${unresolvedKnown
          .map((t) => {
            const name = findInUniverse(t.symbol, t.market)?.name;
            return name ? `${name}(${t.symbol})` : t.symbol;
          })
          .join("、")}這幾檔本站其實有涵蓋，但這一刻資料來源暫時連線不穩、抓不到最新資料，不是不涵蓋`
      );
    }
    if (unresolvedUnknown.length > 0) {
      parts.push(
        `${unresolvedUnknown.map((t) => t.symbol).join("、")}這幾個沒有比對到本站資料庫裡任何股票或公司，可能是名稱/代號打錯，或不在本站資料涵蓋範圍（本站台股目前涵蓋證交所上市（TWSE）、櫃買中心上櫃（TPEx）與興櫃（Emerging）公司；美股則是約150多檔精選跨產業大型股，不是完整美股市場，用公司名稱或代號都可以查）`
      );
    }
    return parts.join("；");
  }
  // 該講哪一句由程式決定（2026-10-06 評測：不存在的 9999 被模型照抄「本站有涵蓋、暫時連不上」那句）。
  function unresolvedReplyHint(): string {
    const hints: string[] = [];
    if (unresolvedKnown.length > 0) hints.push("有涵蓋但暫時抓不到的，要明說「這檔本站有涵蓋，但資料來源暫時連不上，等等再問看看」，不可說成不涵蓋");
    if (unresolvedUnknown.length > 0)
      hints.push(`沒有比對到的${unresolvedUnknown.map((t) => t.symbol).join("、")}，要直說「本站查不到這個代號／名稱，可能打錯或不在本站涵蓋範圍」，不可說成本站有涵蓋或暫時連不上`);
    return `請用自己的話照實回覆：${hints.join("；")}。`;
  }

  // 問的是特定個股時不附一般大盤新聞標題：2026-10-04 使用者回報問「2330 最近走勢如何？」，
  // 回答卻扯進標題裡順帶出現的「台灣精材(3467)與其他個股無關」。個股自己的新聞已在個股資料裡，
  // 大盤層級的重大事件（pinnedEventsText）照常附。
  const [twNews, usNews, intlNews] = stockGroundings.length > 0 ? [[], [], []] : marketNews;
  const marketNewsText = [
    twNews.length > 0 ? `台股：\n${twNews.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}` : "",
    usNews.length > 0 ? `美股：\n${usNews.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}` : "",
    // 國際／地緣政治／總經（戰爭、制裁、油價、Fed…），固定的台股／美股查詢抓不到這類大事。
    intlNews.length > 0
      ? `國際／地緣政治／總經：\n${intlNews.map((n) => `- [${n.pubDate.slice(5, 10)}] ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const pinnedEventsText =
    !focusedStock && newsFeed.pinned.length > 0
      ? newsFeed.pinned.map((p) => `- ${p.title}${p.summary ? `：${p.summary}` : ""}`).join("\n")
      : "";

  // An Opus QA pass found the model would fabricate specific numbers (P/E,
  // volume, institutional flow — all invented) when a user named a real
  // stock outside the site's coverage (at the time, any TPEx/上櫃 company —
  // since covered by tpex.ts/universe.ts, and 興櫃 by emerging.ts, so the
  // TW side is now all three boards) — with no "個股資料" section to signal "not found," it just
  // answered from its own pretrained knowledge instead. Making this
  // explicit (rather than relying only on the general system-prompt
  // instruction not to fabricate, which evidently wasn't enough on its own
  // here) gives the model something concrete to react to.
  // contextSymbol always names a real stock (it comes from a stock detail
  // page the user is already looking at) — a failed fetch there is a
  // transient data problem, not "this isn't a real/covered stock", so it
  // must never trigger either not-found note below.
  const notFoundNote =
    !contextSymbol && targets.length > 0 && stockGroundings.length === 0
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：${describeUnresolved()}。${unresolvedReplyHint()}不要複製這段標記，也不要用自己的知識補任何數字。`
      : "";
  // Partial miss on a multi-stock question (e.g. "環球晶跟世界先進比較" when
  // only one of the two is covered) — some real data was found, so the
  // generic "nothing matched at all" note above doesn't apply, but the
  // model still needs an explicit signal for the specific one that wasn't
  // found, or it risks filling that gap in with its own trained knowledge.
  const partialNotFoundNote =
    !contextSymbol && stockGroundings.length > 0 && unresolvedTargets.length > 0
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：這次問題裡有部分股票/公司查到真實資料（見上方個股資料），另外${describeUnresolved()}。${unresolvedReplyHint()}不要用自己的知識補這幾檔的任何數字，不要複製這段標記。`
      : "";

  const stockGroundingText =
    stockGroundings.length === 0
      ? ""
      : stockGroundings.length === 1
        ? `【個股資料】\n${stockGroundings[0].text}`
        : stockGroundings.map((g, i) => `【個股資料 ${i + 1}：${g.symbol}】\n${g.text}`).join("\n\n");

  // Pure calendar fact, no fetch needed — a user asked for special TW
  // market dates (台指期結算 specifically named) to factor into the model's
  // reasoning about unusual volatility that isn't explained by any one
  // stock's own news. Only surfaced when actually near/on the date, so
  // ordinary days don't get a pointless mention.
  const settlement = isNearTaiexFuturesSettlement(taipeiTodayForAsk());
  const specialDateNote = settlement.isSettlementDay
    ? `今天（${settlement.settlementDateIso}）是台指期（台股期貨/選擇權）結算日，法人為了結算常有調節台股成分股部位的動作，當天大盤或權值股出現平常少見的量價波動，有可能只是結算效應、不一定代表個股/大盤趨勢真的轉變，回答時可以視情況提及這個角度。`
    : settlement.isNear
      ? `本月台指期（台股期貨/選擇權）結算日是 ${settlement.settlementDateIso}，快到了，這幾天大盤/權值股可能會出現法人為結算調節部位的量價波動，回答時可以視情況提及這個角度，不用每次都硬套。`
      : "";

  // 每個區塊都標明「AI 掛掉時可不可以直接拿給使用者看」。
  //
  // 會分這兩種，是因為實測踩到一個真實的外洩問題：Gemini 免費方案是「每分鐘」限流，
  // 連續問幾題就會 429，這時候 callAiProviders 回 usedAi:false，走 buildCannedAnswer
  // 這條退路。原本 buildCannedAnswer 是把整包 grounding 原封不動印給使用者，於是
  // 聊天視窗裡真的出現了「回答時可以視情況提及這個角度，不用每次都硬套。」「股數已經
  // 換算好對應張數，直接引用不要自己重算」「不需要說『沒有資料』」這種寫給 AI 看的
  // 指令，以及【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】這個標記本身——
  // 對使用者來說完全是天書，而且等於把提示詞攤開來給人看。
  //
  // userSafe:false 的區塊有兩類：①純粹是寫給模型的指示（查無資料標記、主題不存在
  // 標記）；②雖然帶著真實數據、但標題/說明裡混了模型指令的清單（今日焦點數據、
  // 台股特殊日期）。第二類不是不能給使用者看，而是要另外寫一份乾淨的版本才行，
  // 在 AI 本來就掛掉的當下，與其印出夾雜指令的半成品，不如誠實請使用者稍後再試。
  const groundingSections: Array<{ text: string; userSafe: boolean }> = [
    // 目前時段與回答立場（盤中／盤後定價／收盤後／週末），見 tradingStance.ts。
    { text: stance.stanceLine, userSafe: false },
    { text: stockGroundingText, userSafe: true },
    { text: comparisonText, userSafe: false },
    { text: fuzzyNote, userSafe: false },
    { text: methodQuestion && targets.length === 0 ? METHOD_QUESTION_NOTE : "", userSafe: false },
    { text: ratingChangeText, userSafe: false },
    { text: notFoundNote, userSafe: false },
    { text: partialNotFoundNote, userSafe: false },
    { text: specialDateNote ? `【台股特殊日期】\n${specialDateNote}` : "", userSafe: false },
    { text: indexText ? `【大盤概況（台股＋美股）】\n${indexText}` : "", userSafe: true },
    { text: marketPulse, userSafe: true },
    {
      text: pinnedEventsText ? `【近期重大事件（AI 已判斷為可能影響整體大盤等級）】\n${pinnedEventsText}` : "",
      userSafe: true,
    },
    { text: topicNewsText, userSafe: true },
    { text: marketNewsText ? `【近期市場新聞】\n${marketNewsText}` : "", userSafe: true },
    {
      text: moversGrounding ? `【今日焦點數據（漲幅榜、技術訊號共振股）】\n${moversGrounding}` : "",
      userSafe: false,
    },
    { text: confidenceGradesText, userSafe: false },
    {
      text: ratingListText ? `【本站綜合評等名單（${actionBrief?.title ?? "今日建議"}同一份，只能從這裡推薦）】\n${ratingListText}` : "",
      userSafe: false,
    },
    {
      text: actionBriefText ? `【今日建議名單（本站用技術面＋籌碼面＋基本面＋財報面多面向評分後的全市場買進候選，與「今日建議」頁同一份）】
${actionBriefText}` : "",
      userSafe: true,
    },
    {
      // 清單標題與說明文字裡夾雜寫給模型看的指示（「可以直接回答今天沒有」
      // 「不要自己回想或推測」），跟「今日焦點數據」同一個理由標成 userSafe:false。
      text: techScreenGrounding ? `【技術指標篩選（多重條件比對用）】\n${techScreenGrounding}` : "",
      userSafe: false,
    },
    { text: themeGrounding ? `【主題股清單】\n${themeGrounding}` : "", userSafe: true },
    { text: conceptText, userSafe: false },
    {
      text: unknownTheme
        ? "【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】本站沒有使用者問的這個主題／概念股分類（只有 TWSE/TPEx 官方產業分類，例如半導體業、航運業、金融保險業、生技醫療業、鋼鐵工業、光電業、通信網路業、資訊服務業，外加一份 AI 供應鏈清單）。請直說「本站目前沒有這個主題的分類清單」，可建議改給幾檔股票代號或改問官方產業分類；不可把今日焦點數據的漲幅榜、共振股、價漲量增股票說成這個主題的成分股——那等於幫真實公司捏造產業分類。"

        : "",
      userSafe: false,
    },
    { text: holdingsGrounding ? `【我的關注清單/持股】\n${holdingsGrounding}` : "", userSafe: true },
    {
      text: holdingsBackgroundNote ? `【關注清單背景（備用，非本題主題）】\n${holdingsBackgroundNote}` : "",
      userSafe: false,
    },
    {
      // 對話焦點：承接上文時明講「現在在談哪一檔」，避免大塊市場資料把注意力拉走。
      text:
        history.length > 0 && stockGroundings.length > 0
          ? `【對話焦點】使用者目前正在討論：${stockGroundings.map((g) => g.symbol).join("、")}。除非使用者明確換題，這句就是延續這個話題。`
          : "",
      userSafe: false,
    },
  ];

  const grounding = groundingSections
    .map((s) => s.text)
    .filter(Boolean)
    .join("\n\n");

  // 依這一題實際附上的資料區塊決定帶哪些規則（見 askSystemCompose.ts）。
  const system = composeAskSystemPrompt({
    question,
    lastUserTurn,
    hasHistory: history.length > 0,
    stockText: stockGroundingText,
    stockCount: stockGroundings.length,
    holdingsText: holdingsGrounding,
    holdingsMode: !holdingsGrounding
      ? "none"
      : wantsHoldingsAnalysis
        ? "deep"
        : holdingsTopical
          ? "light"
          : "target",
    holdingsBackground: !!holdingsBackgroundNote,
    holdingsEmptyAsked:
      holdings.length === 0 &&
      (HOLDINGS_TOPIC_PATTERN.test(question) || HOLDINGS_ANALYSIS_INTENT_PATTERN.test(question)),
    indexText,
    moversText: moversGrounding,
    techScreenText: techScreenGrounding,
    hasTheme: !!themeGrounding,
    hasNotFoundMarker: !!(notFoundNote || partialNotFoundNote),
    singleStockDeep: wantsSingleStockAnalysis,
    marketWide: wantsMarketWide,
    ratingListText,
    hasTradingStance: true,
    listReference,
    asksHighConfidence: !!confidenceGradesText,
    topicNewsText,
    marketPulseText: marketPulse,
    questionType: qc.type,
    conceptText,
    twMarketOpen: getMarketStatus("TW") === "open",
    usMarketOpen: getMarketStatus("US") === "open",
  });

  const userContent = grounding
    ? `參考資料：\n${grounding}\n\n使用者問題：${question}`
    : `使用者問題：${question}\n（目前沒有可用的參考資料，請根據一般金融知識簡短回答，並說明無法取得即時資料。）`;

  const messages: ChatTurn[] = [...history, { role: "user", content: userContent }];
  // A per-stock analysis across a whole watchlist is genuinely long output
  // (each holding gets its own multi-sentence writeup) — the default budget
  // (sized for a normal one-or-two-sentence chat reply) cut this off
  // mid-stock on a real multi-holding watchlist. Scales a little with how
  // many holdings are actually being analyzed rather than a single fixed
  // number, so a 3-stock watchlist doesn't pay for headroom a 12-stock one
  // needs. This is also the one path in this file where a user is
  // knowingly clicking a "give me the full analysis" button and expects to
  // wait a bit, not a live-typing exchange — same tradeoff brief.ts makes
  // for its own long-form generation.
  const callOptions: CallAiProvidersOptions = wantsHoldingsAnalysis
    ? { timeoutMs: 45000, maxOutputTokens: Math.min(2000 + holdings.length * 400, 8000) }
    : wantsSingleStockAnalysis
      ? // Same "user knowingly asked for the full picture, not a quick
        // reply" tradeoff as the holdings case above, just for one stock —
        // the default budget was sized for a short chat answer and cut this
        // kind of multi-paragraph analysis off mid-sentence.
        { timeoutMs: 30000, maxOutputTokens: 2500 }
      : JUDGMENT_QUESTION_PATTERN.test(question) ||
          DEEPER_ANALYSIS_REQUEST_PATTERN.test(question) ||
          wantsHoldingsDecision ||
          qc.type === "market-outlook" ||
          qc.type === "screen-concept"
        ? // 判斷題約 300～450 字、要求再多分析時約 700 字（RULE_CONCISE_ANSWER），預設 1000 tokens 會截斷。
          { maxOutputTokens: 1800 }
        : {};
  const result = await callAiProviders(system, messages, callOptions);
  if (result.usedAi) {
    const provider = result.provider;
    const checked = await finalizeAiAnswer({
      raw: result.answer,
      grounding,
      // 回答後檢查不過：同一個模型帶著錯誤說明重生一次（時間上限短，不拖垮整個請求）。
      regenerate: async (issues) => {
        const retry = await callAiProviders(system, [...messages, ...regenerateTurns(result.answer, issues)], {
          ...callOptions,
          forceProvider: provider,
          timeoutMs: REGENERATE_TIMEOUT_MS,
          totalBudgetMs: REGENERATE_TIMEOUT_MS + 2000,
        });
        return retry.usedAi ? retry.answer : null;
      },
    });
    if (checked.issues.length > 0) console.warn("[ask] 回答後檢查：", checked.outcome, JSON.stringify(checked.issues));
    // 方法題：模型沒講到判斷方式（例如反問「要查哪一檔」）就改用程式版說明（NVIDIA 評測實測會反問）。
    const methodFallback = methodQuestion && targets.length === 0 && !METHOD_ANSWER_PATTERN.test(checked.answer);
    return {
      answer: methodFallback ? METHOD_QUESTION_NOTE.replace(/^【[^】]*】\n/, "") : checked.answer,
      groundedSymbol,
      resolvedTargets: targets.map((t) => t.symbol),
      usedAi: true,
      model: checked.outcome === "program" || methodFallback ? PROGRAM_MODEL : modelInfo(result.model),
    };
  }

  return {
    answer: buildCannedAnswer(groundingSections, groundedSymbol, result.failureReason ?? "未知原因"),
    groundedSymbol,
    resolvedTargets: targets.map((t) => t.symbol),
    usedAi: false,
  };
}

/**
 * AI 回答送出前的程式後處理（唯一入口；跨模型評測 scripts/eval/run.ts 也呼叫這一個，兩邊才不會漂移）：
 * 清內部標記 → 拿掉評等標籤 → 關鍵價位抄錯更正為程式值（numberGuard.ts）→ 先不要買的股票刪掉出場價／買進區間 →
 * 持有中的持有動作照程式字樣（guardHeldAnswer；兩者都在 ratingConsistencyGuard.ts）→ 評等變動沒交代就補程式說明（ratingChange.ts）→ 融資融券組合判讀沒講出就補程式說明（marginSignal.ts）。
 */
export function postProcessAiAnswer(answer: string, grounding: string): string {
  const guarded = guardAnswerNumbers(
    ensureFuzzyConfirmation(stripNameMarkersInText(stripRatingTags(sanitizeLeakedMarkers(answer))), grounding),
    grounding
  );
  if (guarded.fixes.length > 0) console.warn("[ask] 更正 AI 抄錯的價位：", JSON.stringify(guarded.fixes));
  const consistent = guardAvoidPriceAdvice(guarded.text, grounding);
  if (consistent.fixes.length > 0) console.warn("[ask] 刪掉先不要買股票的價位建議：", JSON.stringify(consistent.fixes));
  // 持有中：持有動作逐字照程式（不可把減碼升級成停損／全部賣出、不可混寫減碼或出場、虧損不可寫獲利已吐回）。
  const held = guardHeldAnswer(consistent.text, grounding);
  if (held.fixes.length > 0 || held.appended.length > 0)
    console.warn("[ask] 更正持有建議：", JSON.stringify({ fixes: held.fixes, appended: held.appended }));
  // 關注清單深度分析漏掉的股票補一行程式結論。
  const covered = guardHoldingsCoverage(held.text, grounding);
  if (covered.appended.length > 0) console.warn("[ask] 補漏掉的關注清單股票：", JSON.stringify(covered.appended));
  // 評等跟前一交易日不同、回答卻沒交代的，補上程式說明（ratingChange.ts）。
  const changed = ensureRatingChangeExplained(covered.text, grounding);
  if (changed.appended.length > 0) console.warn("[ask] 補評等變動說明：", JSON.stringify(changed.appended));
  // 融資融券組合判讀有訊號、回答提到該檔卻沒講出訊號名稱的，補上程式說明（marginSignal.ts）。
  const margin = ensureMarginSignalMentioned(changed.text, grounding);
  if (margin.appended.length > 0) console.warn("[ask] 補融資融券組合判讀：", JSON.stringify(margin.appended));
  // 每檔現價（即時報價）與本站把握程度（程式判定）：買賣判斷題／關注清單深度分析回答提到某檔卻沒講的，補程式寫好的字樣（stockFactsMention.ts）。
  const facts = ensureStockFactsMentioned(margin.text, grounding);
  if (facts.appended.length > 0) console.warn("[ask] 補現價／把握程度：", JSON.stringify(facts.appended));
  // 提到三大法人買賣超、資料卻不是今天的（盤中沒有官方當天資料），回答沒交代日期的補一句（chipsDateMention.ts）。
  const chipsDated = ensureChipsDateMentioned(facts.text, grounding);
  if (chipsDated.appended.length > 0) console.warn("[ask] 補法人資料日期說明：", JSON.stringify(chipsDated.appended));
  return chipsDated.text;
}

/**
 * 評等改變說明（只看台股、最多 RATING_CHANGE_MAX 檔；評等讀同一份 10 分鐘快取，不記評等紀錄；3 秒內拿不到就不附）。
 * 上限 15：關注清單題要涵蓋整份清單（評等剛被 rateHoldings 算過、快取命中；Redis 只多一個 pipeline）。
 */
const RATING_CHANGE_MAX = 15;
const RATING_CHANGE_WAIT_MS = 3000;
async function buildRatingChangeText(symbols: string[], heldSymbols: Set<string> = new Set()): Promise<string> {
  const tw = [...new Set(symbols.map((s) => s.toUpperCase()))].filter((s) => /^\d{4,6}[A-Z]?$/.test(s)).slice(0, RATING_CHANGE_MAX);
  if (tw.length === 0) return "";
  const work = (async () => {
    const ratings = (await Promise.all(tw.map((s) => getStockRating(s, "TW").catch(() => null)))).filter((r) => r != null);
    return describeRatingChanges(
      ratings.map((r) => ({
        name: r.name,
        symbol: r.symbol,
        price: r.price,
        rating: r.rating,
        facets: r.facets,
        held: heldSymbols.has(r.symbol.toUpperCase()),
      }))
    );
  })().catch(() => "");
  return Promise.race([work, new Promise<string>((resolve) => setTimeout(() => resolve(""), RATING_CHANGE_WAIT_MS))]);
}

// ---------------------------------------------------------------- 回答後檢查＋自動重生（2026-10-06「提高 Lite 下限」）

/** 問「把握程度高的」（推薦／名單）。 */
const HIGH_CONFIDENCE_QUESTION_PATTERN = /把握(?:程度)?.{0,3}(?:最)?高|高把握|最有把握|把握(?:程度)?.{0,2}(?:最大|最強)/;
const HIGH_CONFIDENCE_LIST_PATTERN = /股票|哪些|哪幾|哪[檔支]|名單|推薦|標的/;
const THIS_STOCK_PATTERN = /這[檔支間家]|它|這間公司/;

/** 「建議買嗎」這類短追問：主題在上一句。 */
const SHORT_FOLLOWUP_MAX_LEN = 8;
/** JUDGMENT_QUESTION_PATTERN 以外也算買賣判斷的字眼。 */
const TRADE_JUDGMENT_EXTRA_PATTERN = /買嗎|賣嗎|停損|停利|加碼|減碼|續抱|追高|明天.{0,4}(漲|跌)|會漲|會跌/;
/** 比較題（多檔時才看）。 */
const COMPARISON_QUESTION_PATTERN = /比較|哪(一|個|檔|支|只)|選|還是|vs|VS|跟.{1,8}(誰|哪)/;
/** 大盤題：問整體盤勢或今天值得注意什麼（不含個股名稱時才看）。 */
const MARKET_OVERVIEW_QUESTION_PATTERN =
  /(大盤|台股|股市|盤勢|行情|加權).{0,8}(怎樣|怎麼樣|如何|表現|狀況|重點|值得注意|注意什麼|發生什麼|為什麼)|(今天|今日|最近).{0,8}(有什麼|有啥|有哪些).{0,6}(值得注意|重點|焦點|大事)/;
/** 重生的時間上限：正式站整個請求 60 秒，前面組資料與第一次回答已用掉大半。 */
const REGENERATE_TIMEOUT_MS = 15_000;
/** 重生仍不合格、改用程式版回答時的模型標示。 */
const PROGRAM_MODEL = { id: "site-program", name: "本站程式版（AI 回答未通過檢查）" };

/** 重生時附加的兩則對話（評測 run.ts 也用這個，兩邊一致）。 */
export function regenerateTurns(previous: string, issues: string[]): ChatTurn[] {
  return [
    { role: "assistant", content: previous },
    {
      role: "user",
      content: `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】你剛才的回答沒有通過檢查：${issues.join("；")}。請依同一份參考資料重寫完整回答（直接給新回答，不要道歉、不要提到這段檢查）。`,
    },
  ];
}

/** 截斷時退而求其次：只留到最後一個完整句子（留下的不到一半就不砍）。 */
function trimToLastSentence(answer: string): string {
  const m = answer.match(/^[\s\S]*[。！？!?]/);
  return m && m[0].length >= answer.length * 0.5 ? m[0] : answer;
}

export interface FinalizeResult {
  answer: string;
  /** ok＝通過（或無從補救）；regenerated＝重生後通過；program＝改用程式版；trimmed＝截斷只留完整句子 */
  outcome: "ok" | "regenerated" | "program" | "trimmed";
  issues: string[];
}

/**
 * 回答後處理＋檢查＋重生（唯一入口；評測 scripts/eval/run.ts 也呼叫這一個）：
 * postProcessAiAnswer → answerCardIssues（第一句與結論卡一致、建議買進不可寫等回檔、截斷）→
 * 不過就用同一個模型重生一次 → 仍不過：有結論卡用程式版回答，只有截斷就留到最後完整句子。
 */
export async function finalizeAiAnswer(input: {
  raw: string;
  grounding: string;
  regenerate?: (issues: string[]) => Promise<string | null>;
}): Promise<FinalizeResult> {
  const first = postProcessAiAnswer(input.raw, input.grounding);
  const issues = answerIssues(first, input.grounding);
  if (issues.length === 0) return { answer: first, outcome: "ok", issues };
  const retryRaw = input.regenerate ? await input.regenerate(issues).catch(() => null) : null;
  if (retryRaw) {
    const second = postProcessAiAnswer(retryRaw, input.grounding);
    const issues2 = answerIssues(second, input.grounding);
    if (issues2.length === 0) return { answer: second, outcome: "regenerated", issues };
    if (issues2.every(isRepairableIssue)) return { answer: repairAnswer(second, input.grounding, issues2), outcome: "trimmed", issues: issues2 };
  }
  if (issues.every(isRepairableIssue) && (looksTruncated(first) || issues.some(isUngroundedPriceIssue)))
    return { answer: repairAnswer(first, input.grounding, issues), outcome: "trimmed", issues };
  const program = renderCardFallback(input.grounding);
  if (program) return { answer: program, outcome: "program", issues };
  // 沒有結論卡可退：至少把沒有出處的價格句刪掉（不讓編的股價送到使用者面前）。
  return { answer: issues.some(isUngroundedPriceIssue) ? repairAnswer(first, input.grounding, issues) : first, outcome: "ok", issues };
}

/** 回答後檢查（唯一入口）：結論卡一致性（decisionCard.ts）＋股價／指數不可沒有出處（numberGuard.ts findUngroundedPrices）。 */
function answerIssues(answer: string, grounding: string): string[] {
  return [...answerCardIssues(answer, grounding), ...ungroundedPriceIssues(findUngroundedPrices(answer, grounding))];
}

/** 程式可以自行修補的問題：截斷（留到最後完整句子）、沒有出處的價格（刪句）。 */
function repairAnswer(answer: string, grounding: string, issues: string[]): string {
  let text = answer;
  if (issues.some(isUngroundedPriceIssue)) text = stripUngroundedPriceSentences(text, findUngroundedPrices(text, grounding));
  if (issues.some(isTruncationIssue) && looksTruncated(text)) text = trimToLastSentence(text);
  return text;
}

function isTruncationIssue(issue: string): boolean {
  return issue.startsWith(TRUNCATION_ISSUE_PREFIX);
}

function isUngroundedPriceIssue(issue: string): boolean {
  return issue.startsWith(UNGROUNDED_PRICE_ISSUE_PREFIX);
}

function isRepairableIssue(issue: string): boolean {
  return isTruncationIssue(issue) || isUngroundedPriceIssue(issue);
}
