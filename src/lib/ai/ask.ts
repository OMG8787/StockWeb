import { findInUniverse, getIndices, getMacroSnapshot, getTaifexNightFutures } from "@/lib/data";
import { buildMarketOverviewText } from "./marketOverview";
import type { Market } from "@/lib/data";
import { fetchNews, fetchUsMarketNews } from "@/lib/data/news";
import { callAiProviders } from "@/lib/ai/provider";
import { getNewsFeed } from "@/lib/ai/newsfeed";
import { getActionBrief } from "@/lib/ai/actionBrief";
import { isNearTaiexFuturesSettlement } from "@/lib/marketCalendar";
import type { ChatTurn } from "@/lib/ai/types";
import type { AskResult, HoldingInput } from "./askTypes";
import { guessSymbolsFromText } from "./symbolResolve";
import {
  conversationWantsMovers,
  conversationWantsTechScreen,
  detectHistoryPeriod,
  wantsMarketWideBuyIdea,
  resolveFollowupTargets,
  HOLDINGS_ANALYSIS_INTENT_PATTERN,
  HOLDINGS_TOPIC_PATTERN,
  SINGLE_STOCK_ANALYSIS_INTENT_PATTERN,
  TECH_INDICATOR_PATTERN,
} from "./intent";
import { buildStockGrounding } from "./grounding/stock";
import { buildMoversGrounding } from "./grounding/movers";
import { buildTechScreenGrounding } from "./grounding/techScreen";
import { buildHoldingsAnalysisGrounding, buildHoldingsGrounding } from "./grounding/holdings";
import { buildThemeGrounding, detectTheme, THEME_QUESTION_PATTERN } from "./grounding/theme";
import { buildCannedAnswer, sanitizeLeakedMarkers } from "./askFallback";
import { composeAskSystemPrompt } from "./askSystemCompose";
import { getMarketStatus } from "@/lib/marketStatus";

// `@/lib/ai/ask` 的公開介面刻意保持不變：這兩個型別原本就宣告在這個檔案裡，
// 拆檔之後搬到 askTypes.ts，這裡再原樣匯出，呼叫端（api/ask/route.ts）完全
// 不用改。
export type { AskResult, HoldingInput };

/** Same pattern as twse.ts's own taipeiToday() — each module keeps a small
 *  local copy rather than sharing one, consistent with how us.ts/tpex.ts
 *  already each own their own small date helpers in this codebase. */
function taipeiTodayForAsk(): { year: number; month: number; day: number } {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" })
    .format(new Date())
    .split("-")
    .map((n) => parseInt(n, 10));
  return { year: y, month: m, day: d };
}

export async function answerQuestion(
  question: string,
  contextSymbol?: string,
  history: ChatTurn[] = [],
  holdings: HoldingInput[] = []
): Promise<AskResult> {
  let targets: Array<{ symbol: string; market: Market | undefined }> = contextSymbol
    ? [{ symbol: contextSymbol, market: undefined as Market | undefined }]
    : await guessSymbolsFromText(question);
  // A themed request ("AI概念股有哪些") only makes sense to check when the
  // question didn't already resolve to specific stock(s) — "台積電是不是
  // AI概念股" should still ground 台積電 itself, not switch over to the
  // theme screen.
  const themeMatch = targets.length === 0 ? detectTheme(question) : undefined;
  // 問的是主題/概念股，但本站沒有這個主題的分類資料（見 THEME_QUESTION_PATTERN
  // 的說明）——這種情況要明講，不能讓 AI 拿一般的今日焦點清單冒充成該主題的成分股。
  const unknownTheme = targets.length === 0 && !themeMatch && THEME_QUESTION_PATTERN.test(question);
  const wantsMovers = targets.length === 0 && !themeMatch && conversationWantsMovers(question, history);
  // 「用技術指標條件篩股票」跟上面的 wantsMovers 是兩個獨立的需求：問「有沒有
  // MACD跟KD都黃金交叉的股票」時需要的是全市場逐檔算過的指標明細，不是漲幅榜；
  // 反過來問「今天有哪些股票不錯」則不需要那份很長的指標表。兩者可以同時成立
  // （例如「有沒有均線多頭排列、適合明天買的股票」），各自附各自的資料。
  const wantsTechScreen = targets.length === 0 && !themeMatch && conversationWantsTechScreen(question, history);
  // 這一句沒寫出股票名稱、也不是主題/篩選問題，但看起來是在追問上文提過的某一檔
  // （「第一檔的本益比多少?」「這檔法人買超多少?」）——把那一檔從對話紀錄裡
  // 找回來當成目標，否則會完全沒有個股資料、誤答成「查不到這檔股票的資料」。
  // 刻意排在 themeMatch/wantsMovers/wantsTechScreen 之後判斷，確保全市場篩選類
  // 問題永遠優先，不會被誤解成在問某一檔。
  if (targets.length === 0 && !themeMatch && !unknownTheme && !wantsMovers && !wantsTechScreen && history.length > 0) {
    targets = await resolveFollowupTargets(question, history);
  }
  const wantsHoldingsAnalysis = holdings.length > 0 && HOLDINGS_ANALYSIS_INTENT_PATTERN.test(question);
  // 開放式「建議買什麼」→ 範圍是全市場，見 intent.ts wantsMarketWideBuyIdea 的說明。
  const wantsMarketWide = targets.length === 0 && !themeMatch && !unknownTheme && !wantsHoldingsAnalysis && wantsMarketWideBuyIdea(question);
  // 今日建議頁已經算好的全市場多面向買進候選（30分鐘快取，跟 /action 頁同一份，兩邊答案才會一致）；
  // 冷快取時最多等8秒，逾時就不附，不拖慢聊天回應。
  const actionBriefPromise: Promise<string> = wantsMarketWide
    ? Promise.race([
        getActionBrief().then((b) => (b.usedAi ? b.text : "")).catch(() => ""),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 8000)),
      ])
    : Promise.resolve("");
  // The "問AI關於<股票>" button on every stock page pre-fills exactly this
  // phrasing (see ChatWidget.tsx's ASK_ABOUT_EVENT handler) — a user asked
  // for this button's answer to be as precise/thorough as the watchlist
  // deep-analysis feature, for every stock, not just ones being held.
  // Gated on contextSymbol (this button is the only thing that sets it) so
  // a narrower follow-up question in the same conversation — "殖利率多少"
  // — doesn't get inflated into a full write-up it didn't ask for.
  const wantsSingleStockAnalysis = !!contextSymbol && SINGLE_STOCK_ANALYSIS_INTENT_PATTERN.test(question);

  // 關注清單只在這一句（或上一句使用者的話）真的在談持股時，才附逐檔報價損益；否則
  // 只附一份「名單背景」（名稱＋代號，不抓報價）。2026-10-04 使用者反映 AI 聊著聊著
  // 跳題：只要使用者有關注清單，每一題都被塞進整份逐檔損益，加上 RULE_HOLDINGS_LIGHT
  // 要求「逐檔講重點」，模型就會在不相干的回答尾巴自己盤點起整份清單。
  // 正在討論的那一檔剛好是持股時，只附那一檔的那一行（成本損益一句話帶過用）。
  const lastUserTurn = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const holdingsTopical =
    wantsHoldingsAnalysis || HOLDINGS_TOPIC_PATTERN.test(question) || HOLDINGS_TOPIC_PATTERN.test(lastUserTurn);
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
  ] =
    await Promise.all([
      // 問到過去某天/某段期間時，個股【歷史脈絡】多附該期間逐日明細；多檔比較時每檔歷史脈絡精簡版。
      Promise.all(
        targets.map((t) =>
          buildStockGrounding(t, { period: detectHistoryPeriod(question, taipeiTodayForAsk()), compact: targets.length > 1 })
        )
      ),
      Promise.all([getIndices(), getTaifexNightFutures().catch(() => null), getMacroSnapshot()])
        .then(([indices, taifexFutures, macro]) => buildMarketOverviewText(indices, taifexFutures, macro))
        .catch(() => ""),
      wantsMovers ? buildMoversGrounding() : Promise.resolve(""),
      wantsTechScreen ? buildTechScreenGrounding().catch(() => "") : Promise.resolve(""),
      themeMatch ? buildThemeGrounding(themeMatch) : Promise.resolve(""),
      (wantsHoldingsAnalysis
        ? buildHoldingsAnalysisGrounding(holdings)
        : buildHoldingsGrounding(holdingsForGrounding, TECH_INDICATOR_PATTERN.test(question))
      ).catch(() => ""),
      Promise.all([fetchNews("台股", 6), fetchUsMarketNews(5)]).catch(() => [[], []] as const),
      // Shares the same 20-minute cache as the /news page's AI classifier —
      // a near-free reuse of work already done there (which items are
      // genuinely market-moving, plus a one-line plain-language "what this
      // means" for each) rather than re-deriving importance from the raw
      // headlines below.
      getNewsFeed().catch(() => ({ pinned: [], items: [], generatedAt: "" })),
    ]);

  const actionBriefText = await actionBriefPromise;

  const stockGroundings = stockGroundingResults.filter((g): g is { symbol: string; text: string } => g !== undefined);
  if (stockGroundings.length > 0) groundedSymbol = stockGroundings[0].symbol;
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

  const [twNews, usNews] = marketNews;
  const marketNewsText = [
    twNews.length > 0 ? `台股：\n${twNews.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}` : "",
    usNews.length > 0 ? `美股：\n${usNews.map((n) => `- ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const pinnedEventsText =
    newsFeed.pinned.length > 0
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
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：${describeUnresolved()}。請用自己的話照實回覆：暫時連不上的要明說「這檔本站有涵蓋，但資料來源暫時連不上，等等再問看看」，不可說成不涵蓋；不要複製這段標記，也不要用自己的知識補任何數字。`
      : "";
  // Partial miss on a multi-stock question (e.g. "環球晶跟世界先進比較" when
  // only one of the two is covered) — some real data was found, so the
  // generic "nothing matched at all" note above doesn't apply, but the
  // model still needs an explicit signal for the specific one that wasn't
  // found, or it risks filling that gap in with its own trained knowledge.
  const partialNotFoundNote =
    !contextSymbol && stockGroundings.length > 0 && unresolvedTargets.length > 0
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：這次問題裡有部分股票/公司查到真實資料（見上方個股資料），另外${describeUnresolved()}。請用自己的話照實回覆（暫時連不上的要明說本站有涵蓋、等等再問，不可說成不涵蓋），不要用自己的知識補這幾檔的任何數字，不要複製這段標記。`
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
    { text: stockGroundingText, userSafe: true },
    { text: notFoundNote, userSafe: false },
    { text: partialNotFoundNote, userSafe: false },
    { text: specialDateNote ? `【台股特殊日期】\n${specialDateNote}` : "", userSafe: false },
    { text: indexGrounding ? `【大盤概況（台股＋美股）】\n${indexGrounding}` : "", userSafe: true },
    {
      text: pinnedEventsText ? `【近期重大事件（AI 已判斷為可能影響整體大盤等級）】\n${pinnedEventsText}` : "",
      userSafe: true,
    },
    { text: marketNewsText ? `【近期市場新聞】\n${marketNewsText}` : "", userSafe: true },
    {
      text: moversGrounding ? `【今日焦點數據（漲幅榜、技術訊號共振股）】\n${moversGrounding}` : "",
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
    indexText: indexGrounding,
    moversText: moversGrounding,
    techScreenText: techScreenGrounding,
    hasTheme: !!themeGrounding,
    hasNotFoundMarker: !!(notFoundNote || partialNotFoundNote),
    singleStockDeep: wantsSingleStockAnalysis,
    marketWide: wantsMarketWide,
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
  const result = wantsHoldingsAnalysis
    ? await callAiProviders(system, messages, {
        timeoutMs: 45000,
        maxOutputTokens: Math.min(2000 + holdings.length * 400, 8000),
      })
    : wantsSingleStockAnalysis
      ? // Same "user knowingly asked for the full picture, not a quick
        // reply" tradeoff as the holdings case above, just for one stock —
        // the default budget was sized for a short chat answer and cut this
        // kind of multi-paragraph analysis off mid-sentence.
        await callAiProviders(system, messages, { timeoutMs: 30000, maxOutputTokens: 2500 })
      : await callAiProviders(system, messages);
  if (result.usedAi) {
    return { answer: sanitizeLeakedMarkers(result.answer), groundedSymbol, usedAi: true };
  }

  return {
    answer: buildCannedAnswer(groundingSections, groundedSymbol, result.failureReason ?? "未知原因"),
    groundedSymbol,
    usedAi: false,
  };
}
