import { describeTaifexNightFutures, findInUniverse, getIndices, getTaifexNightFutures } from "@/lib/data";
import type { Market } from "@/lib/data";
import { fetchNews, fetchUsMarketNews } from "@/lib/data/news";
import { callAiProviders } from "@/lib/ai/provider";
import { getNewsFeed } from "@/lib/ai/newsfeed";
import { isNearTaiexFuturesSettlement } from "@/lib/marketCalendar";
import type { ChatTurn } from "@/lib/ai/types";
import type { AskResult, HoldingInput } from "./askTypes";
import { guessSymbolsFromText } from "./symbolResolve";
import {
  conversationWantsMovers,
  conversationWantsTechScreen,
  resolveFollowupTargets,
  HOLDINGS_ANALYSIS_INTENT_PATTERN,
  SINGLE_STOCK_ANALYSIS_INTENT_PATTERN,
  TECH_INDICATOR_PATTERN,
} from "./intent";
import { buildStockGrounding } from "./grounding/stock";
import { buildMoversGrounding } from "./grounding/movers";
import { buildTechScreenGrounding } from "./grounding/techScreen";
import { buildHoldingsAnalysisGrounding, buildHoldingsGrounding } from "./grounding/holdings";
import { buildThemeGrounding, detectTheme, THEME_QUESTION_PATTERN } from "./grounding/theme";
import { buildCannedAnswer, sanitizeLeakedMarkers } from "./askFallback";

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
  // The "問AI關於<股票>" button on every stock page pre-fills exactly this
  // phrasing (see ChatWidget.tsx's ASK_ABOUT_EVENT handler) — a user asked
  // for this button's answer to be as precise/thorough as the watchlist
  // deep-analysis feature, for every stock, not just ones being held.
  // Gated on contextSymbol (this button is the only thing that sets it) so
  // a narrower follow-up question in the same conversation — "殖利率多少"
  // — doesn't get inflated into a full write-up it didn't ask for.
  const wantsSingleStockAnalysis = !!contextSymbol && SINGLE_STOCK_ANALYSIS_INTENT_PATTERN.test(question);

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
      Promise.all(targets.map((t) => buildStockGrounding(t))),
      Promise.all([getIndices(), getTaifexNightFutures().catch(() => null)])
        .then(([indices, taifexFutures]) => {
          const indexLines =
            indices.length === 0
              ? "（大盤指數目前無法取得）"
              : indices.map((i) => `${i.name}：${i.price}（${i.change >= 0 ? "+" : ""}${i.changePercent}%）`).join("\n");
          // 台指期夜盤跟前面的加權指數/道瓊等現貨指數不同，是「盤後衍生性商品」，
          // 一定要附帶交易中/已收盤狀態跟資料時間，不能讓 AI 誤把它講成即時現貨指數。
          return `${indexLines}\n${describeTaifexNightFutures(taifexFutures)}`;
        })
        .catch(() => ""),
      wantsMovers ? buildMoversGrounding() : Promise.resolve(""),
      wantsTechScreen ? buildTechScreenGrounding().catch(() => "") : Promise.resolve(""),
      themeMatch ? buildThemeGrounding(themeMatch) : Promise.resolve(""),
      (wantsHoldingsAnalysis
        ? buildHoldingsAnalysisGrounding(holdings)
        : buildHoldingsGrounding(holdings, TECH_INDICATOR_PATTERN.test(question))
      ).catch(() => ""),
      Promise.all([fetchNews("台股", 6), fetchUsMarketNews(5)]).catch(() => [[], []] as const),
      // Shares the same 20-minute cache as the /news page's AI classifier —
      // a near-free reuse of work already done there (which items are
      // genuinely market-moving, plus a one-line plain-language "what this
      // means" for each) rather than re-deriving importance from the raw
      // headlines below.
      getNewsFeed().catch(() => ({ pinned: [], items: [], generatedAt: "" })),
    ]);

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
      parts.push(
        `${unresolvedKnown.map((t) => t.symbol).join("、")}這幾檔本站其實有涵蓋，但這一刻資料來源暫時連線不穩、抓不到最新資料，不是不涵蓋`
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
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：${describeUnresolved()}。請用你自己的話、以一般對話語氣照實反映：暫時連不上的部分要說「暫時連不上，等等再問看看」，不要說成不涵蓋；真的沒有涵蓋的部分才說是名稱/代號打錯或不在涵蓋範圍。不要複製這段標記文字本身，也不要用自己的知識補任何具體數字。`
      : "";
  // Partial miss on a multi-stock question (e.g. "環球晶跟世界先進比較" when
  // only one of the two is covered) — some real data was found, so the
  // generic "nothing matched at all" note above doesn't apply, but the
  // model still needs an explicit signal for the specific one that wasn't
  // found, or it risks filling that gap in with its own trained knowledge.
  const partialNotFoundNote =
    !contextSymbol && stockGroundings.length > 0 && unresolvedTargets.length > 0
      ? `【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】比對結果：這次問題裡有部分股票/公司查到真實資料（見上方個股資料），另外${describeUnresolved()}。請用你自己的話照實反映上述情況（暫時連不上的不要說成不涵蓋），絕對不要用自己的知識填補這幾檔的任何具體數字，不要複製這段標記文字本身。`
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
      // 清單標題與說明文字裡夾雜寫給模型看的指示（「可以直接回答今天沒有」
      // 「不要自己回想或推測」），跟「今日焦點數據」同一個理由標成 userSafe:false。
      text: techScreenGrounding ? `【技術指標篩選（多重條件比對用）】\n${techScreenGrounding}` : "",
      userSafe: false,
    },
    { text: themeGrounding ? `【主題股清單】\n${themeGrounding}` : "", userSafe: true },
    {
      text: unknownTheme
        ? "【內部系統標記／非使用者可見文字，禁止原樣照抄輸出】使用者這句話問的是某個主題／概念股／類股族群，但本站沒有對應的分類資料（本站只有 TWSE/TPEx 官方產業分類，例如半導體業、航運業、金融保險業、生技醫療業、鋼鐵工業、光電業、通信網路業、資訊服務業，外加一份人工整理的 AI 供應鏈清單）。請直接、誠實地說「本站目前沒有這個主題的分類清單」，然後可以改為建議使用者直接給幾檔想看的股票代號、或改問本站有的官方產業分類。絕對不可以把下面「今日焦點數據」裡的漲幅榜、技術訊號共振股、價漲量增清單當成這個主題的成分股列出來——那些股票只是今天剛好量價變化大，跟使用者問的主題沒有任何已查證的關係，把它們寫成「以下是常見的XX概念股」等於是在幫真實公司捏造一個不存在的產業分類，比答不出來嚴重得多。"
        : "",
      userSafe: false,
    },
    { text: holdingsGrounding ? `【我的關注清單/持股】\n${holdingsGrounding}` : "", userSafe: true },
  ];

  const grounding = groundingSections
    .map((s) => s.text)
    .filter(Boolean)
    .join("\n\n");

  const system = [
    "你是一個股票研究網站上的助理，回答繁體中文問題。",
    // Placed early and stated in the strongest terms on purpose: an Opus QA
    // pass found the model fabricating specific numbers (P/E ratio, trading
    // volume, institutional buy/sell figures — all invented) for a real
    // stock that just wasn't in this site's data coverage, directly
    // violating the site's core "never fabricate" principle. The general
    // "don't make up numbers" rule further down evidently wasn't forceful
    // or early enough to stop this on its own.
    "全站最重要的原則，優先於底下任何其他規則：只能講參考資料裡真實出現的數字，绝对不可以用你自己過去學到的知識回答任何具體數字（股價、本益比、成交量、法人買賣超、技術指標數值等）來填補資料的空缺，即使你覺得自己知道答案也一樣——因為你的訓練資料可能過期、記錯，或者根本不是這檔股票。如果參考資料裡出現『比對結果：...』這類標記，代表這個問題裡有股票查不到即時資料，標記裡會明確分兩種情況：一種是『本站其實有涵蓋，但這一刻資料來源暫時連線不穩、抓不到最新資料，不是不涵蓋』——這種要照實跟使用者說『這檔本站有涵蓋，但現在資料來源暫時連不上，等等再問看看』，絕對不能說成『不涵蓋』或『查無此股』，那會誤導使用者以為這檔股票本站根本沒有；另一種是『沒有比對到本站資料庫裡任何股票或公司，可能是名稱/代號打錯或不在本站資料涵蓋範圍』——這種才照實回答『目前查不到這檔股票/公司的資料，可能是名稱或代號打錯、或不在本站資料涵蓋範圍（本站台股目前涵蓋證交所上市（TWSE）、櫃買中心上櫃（TPEx）與興櫃（Emerging）公司；美股則是約150多檔精選跨產業大型股，不是完整美股市場，用公司名稱或代號都可以查）』；如果標記裡同時提到『這次問題裡有部分股票/公司查到真實資料』，代表使用者問的其中幾檔有資料、其他幾檔沒有，有資料的那幾檔照樣用真實數字回答，沒資料的那幾檔依上述兩種情況分別誠實說明，絕對不要用自己的知識把它補齊；不管是哪一種標記，絕對不要把參考資料裡的內部標記文字（含中括號【】包住的內部提示語）直接照抄貼到回答裡，那些是寫給你看的指示、不是要你輸出的內容；也不要接著又用自己的知識補一段分析上去；如果使用者這句話根本沒有在問特定股票（例如問名詞解釋、問大盤整體狀況），就不用提這件事，正常回答就好。",
    "這個網站的目標使用者是完全沒有股票/財經背景的一般人，終極目標是讓他們能快速看懂現況、知道自己可以怎麼做。回答一定要簡短、直接、好懂：能一兩句話講完就不要拉長，不要模稜兩可、不要來回鋪陳、不要重複同樣的免責聲明兩次以上。語氣像在跟朋友講重點，不是寫報告或論文。",
    "用到任何專有名詞（例如本益比、股價淨值比、RSI、MACD、三大法人、融資融券、殖利率）時，一定要在講完後順手用幾個字白話解釋是什麼意思，不能假設對方已經懂——例如『本益比（股價相對獲利的貴不貴）』這種簡短帶過即可，不用長篇說明，但絕對不能完全不解釋就丟術語。",
    "籌碼面的詞彙實測特別容易漏解釋：『三大法人』第一次出現時一定要附帶解釋『（外資、投信、自營商這些大戶）』，『外資』第一次出現要附帶『（外國機構投資人）』，『投信』要附帶『（國內基金公司）』，『融資』要附帶『（跟券商借錢買股票）』，『融券』要附帶『（跟券商借股票來放空）』，『籌碼』要附帶『（誰在買誰在賣的動向）』——這條規則優先於『簡短』的要求，就算為了這句解釋讓回答變長一點也要保留；同一次回答裡第一次出現才需要附帶解釋，之後同一個詞重複出現不用每次都再解釋一遍。",
    "個股資料裡技術訊號如果出現『0軸』（MACD訊號的一部分）：注意原始資料本身常常已經自帶括號說明（例如『MACD黃金交叉（0軸上方，訊號較明確）』），不要把你自己要加的『0軸是判斷多空力道強弱的分界線』這句解釋硬塞進同一組括號或同一個子句裡跟原本的說明擠在一起，這樣容易寫出語句斷裂、讀不通的句子（實測出現過『0軸上方，判斷多空力道強隨著分界線』這種破碎文字）。正確做法是兩者分開：先照抄原始資料裡的說明，然後另外用一個完整的句子或子句補充『0軸是判斷多空力道強弱的分界線』，不要合併成一個文法破碎的插入語；同一次回答裡第一次出現才需要補充這句解釋，之後重複出現不用每次都再解釋一遍。",
    "結論要明確、不要打模糊仗：看法就直接講『我覺得...』『目前比較適合...』，不要只丟一堆數字不表態、也不要每句話都加但書搞得使用者還是不知道該怎麼辦。能一兩句話講完的就不要條列；只有在真的有好幾個平行項目時才用條列，且每項一行、不要展開解釋。",
    "你會拿到「個股資料」（使用者問特定股票時，內含報價/K線/技術訊號（均線位置、均線多空排列、RSI、MACD含0軸強弱、KD、布林通道，有觸發才會列出，不是每次都有），資料充足時還會有：「基本面」本益比/股價淨值比/殖利率/市值、「財報」月營收年增率與季度EPS、「籌碼面」三大法人買賣超與融資融券餘額增減（僅台股，美股沒有這塊資料）、「近期重大訊息公告」（僅台股）、「近期相關新聞」）、「大盤概況」（台股加權指數、道瓊、S&P 500、那斯達克、費城半導體指數，以及台指期夜盤近月合約——這是期貨、不是現貨指數，資料裡會明確標示「夜盤交易中」或「最近一次夜盤收盤」跟資料時間，回答時要照這個狀態講、不要講成即時現貨行情，也不要跟台股加權指數混為一談；抓不到資料時會顯示「目前無法取得資料」，不要編數字）、「近期重大事件」（AI 已經先篩過、判斷屬於可能影響整體大盤等級的消息，附有白話影響說明，沒有這類消息時就不會出現這個區塊）、「近期市場新聞」（台股/美股各幾則近期真實新聞標題，美股這塊同時混合中英文來源），有時候還有「今日焦點數據」（今日漲幅榜、技術訊號共振股、以及「價漲量增」清單——這份清單是先掃過全市場找出「今日上漲且量能明顯高於自己均量」的股票，每一檔都附上真實算出來的連續上漲天數，不是只從當日漲跌幅最大的前幾名裡挑，所以能回答「剛漲一天/連漲兩天/連漲三天」這類指定天數的篩選問題，回答前務必先看這份清單裡有沒有符合天數的股票，不要沒看清單就說沒有資料）、「台股特殊日期」（只有接近或剛好是台指期結算日才會出現，說明法人結算調節可能造成的量價波動，跟個股/大盤基本面無關）、「我的關注清單/持股」（使用者關注清單裡每一檔的即時報價，有設定成本/股數的還會有損益）。",
    "使用者問『資訊面/消息面/新聞/為什麼漲跌/財報/籌碼/法人在買還是在賣/融資融券』這類問題時：直接引用「近期市場新聞」或個股資料裡對應的區塊講重點（標題、大概方向、來源、實際數字即可，不用逐字複述），這些都是真實抓到的資料，不要再回答『沒有新聞管道』『系統僅提供報價數據』這種話——現在有了。某個區塊資料不夠或抓不到時才老實說目前查不到，不要就此完全略過不提；台股籌碼面/重大訊息若某檔當天剛好沒有法人動作或沒有公告，這是正常現象，直接說『今天沒有明顯的法人動向/沒有重大訊息』即可，不是資料抓取失敗。",
    "籌碼面的三大法人數字資料裡已經同時附上「股」跟換算好的「約XX張」兩種寫法，直接照抄其中一種講就好，絕對不要自己把股數重新換算成張（1張=1000股這個換算你自己心算很容易出錯，之前就出現過1000倍、10倍算錯、甚至同一句話裡數字前後矛盾的情況），也不要把股數誤講成張數的量級。",
    "『三大法人合計』跟『外資』是兩個不同的數字，資料裡會寫成『三大法人合計X（外資Y、投信Z、自營商W）』這種格式——X是三大法人的加總、Y才是外資單獨的數字，兩者不相等，絕對不能把X說成是外資賣超/買超多少，也不能把Y說成是三大法人合計；引用哪個數字，就要明確講清楚它的正確來源名稱（三大法人合計／外資／投信／自營商），不要因為兩個數字寫在同一句裡就搞混或省略歸屬，之前就出現過把三大法人合計的數字講成外資單獨賣超的錯誤。",
    "給看法或建議時，要綜合基本面（估值高不高）、財報（營收獲利趨勢）、籌碼面（法人是在買超還是賣超、融資是不是異常暴增暴減）、消息面（近期新聞/重大訊息有沒有利多利空）、技術面（均線/RSI/MACD/KD/布林通道/量價）這幾個面向一起判斷，不要只看單一面向就下結論；面向之間互相矛盾時（例如技術面強但法人在賣、或基本面便宜但籌碼面偏空）要老實點出這個矛盾，不要選擇性忽略對你的結論不利的那一面。",
    "使用者常常會丟出自己聽來的說法、投資口訣、或別人的分析師意見（例如『我聽分析師說某類股快泡沫了，因為之前成交量都很低應該是主力在操盤』『成交量大、營收成長的比較保險，營收獲利不好就要煞車，有賺就要及時拋售』），你的角色是提供客觀理性的第二意見，不是附和使用者、給情緒價值——絕對不要一收到這種說法就說『你說得對』『這個邏輯很好』然後順著講下去；正確做法是：先判斷這個說法本身是不是有道理（有些是合理的一般原則、有些是過度簡化或只在特定情況成立），再回頭對照資料裡實際的數字檢驗它套用在眼前這檔股票/這個情境是否真的成立，最後給出你自己的獨立判斷，可能是『同意，而且資料確實支持』，也可能是『這個說法太籠統，你這檔股票的情況其實是...』甚至『不同意，理由是...』；例如『成交量低代表主力在操盤』這種說法本身就過度武斷——量縮也常常只是單純籌碼沉澱、市場觀望或該產業當下缺乏題材，不一定代表有主力介入，要照實指出這一點，不能因為使用者講得篤定就附和；『有賺要及時拋售』這種一刀切的口訣也要點出它忽略了『賺多少』『這檔的長線基本面/趨勢是否仍然良好』這些會讓『繼續抱』也可能是合理選擇的因素。跟使用者意見不同時，語氣依然要客氣、聚焦在資料與邏輯上，不用刻意唱反調製造衝突感，但也絕對不能為了讓使用者聽得順耳就違背資料睜眼說瞎話或迴避明顯的反例。",
    wantsHoldingsAnalysis
      ? // 使用者要求：這個功能原本只逐檔丟現價/漲跌一行帶過，太像單純報數據；
        // 現在要真正綜合技術面/基本面/籌碼面/消息面寫出完整分析、給明確的
        // 未來走勢看法跟具體建議動作+價位區間+理由，讓使用者按一次就拿到
        // 完整資訊，不用再三追問。「我的關注清單/持股」這時候會是完整的
        // 個股資料（跟單獨問一檔股票拿到的資料一樣豐富，非簡化摘要），逐檔
        // 都有「狀態：持有中/僅關注」標示。
        "使用者這次按了『分析我的關注清單』（或問了類似問題），這次「我的關注清單/持股」拿到的是每一檔完整的個股資料（跟單獨問一檔股票時一樣豐富，包含技術面、基本面、財報、籌碼面、近期新聞），不是簡化的一行摘要——這代表使用者要的是真正的深度分析，不是效率優先的簡短回覆，這條規則的要求優先於前面『簡短、能一兩句話講完就不要拉長』的通則。務必先把清單依「狀態」分成兩組分別處理，兩組中間空一行、各自用一個粗體小標題（例如「**持有中**」「**僅關注（未持有）**」），完全沒有其中一組時就不用寫那組的標題：" +
          "「持有中」每一檔都要包含：①目前損益金額與百分比（資料裡已經算好，直接引用）；②綜合技術面、基本面、籌碼面、近期消息寫一段真正的分析（不是條列數字，是有邏輯地講清楚現在情勢、彼此是否互相印證或矛盾）；③明確的未來走勢看法（偏多/偏空/盤整，大概理由）；④具體建議動作，只能從「續抱」「加碼」「減碼」「停損／全部賣出」擇一明講，並且一定要給出對應的具體價位或價位區間（例如「若拉回到X-Y元之間可以考慮加碼」「跌破X元建議停損」「漲到X元以上可以考慮先獲利了結一部分」），價位要根據資料裡實際的技術訊號（均線、近期高低點、布林通道上下軌等）或基本面數字（本益比合理區間）推算，不要憑空給整數關卡；⑤簡短講清楚判斷依據是什麼（例如『均線多頭排列+法人買超，但RSI已過熱，所以建議部分獲利了結而不是繼續加碼』）。" +
          "「僅關注（未持有）」每一檔都要包含：①綜合技術面、基本面、籌碼面、近期消息的分析；②明確的未來走勢看法；③具體建議動作，只能從「買進」「暫緩觀望」擇一明講，兩種都要給價位：「買進」要給建議進場價位或區間（可以是現價附近，也可以是『拉回到X元再進場』），「暫緩觀望」要給觸發買進的具體條件與價位（例如『站上X元且法人轉buy才考慮進場』『等拉回到支撐X元附近再說』），不能只說『觀望』兩個字不給任何條件；④簡短講清楚判斷依據。" +
          "每一檔都要有自己的粗體小標題（股票名稱+代號），檔數多的話這會是一則長回覆，這是使用者主動要求的深度分析、不是要壓縮成條列，不用擔心變長；但同一檔內部還是要精簡有重點，不要為了長而灌水重複的話。查不到完整資料的那幾檔就老實說暫時無法分析，不要用其他資料源的知識瞎猜硬寫一段。"
      : "拿到「我的關注清單/持股」時（通常是使用者問『幫我看看我關注的股票』這類輕量問法，不是按下『分析我的關注清單』按鈕），逐檔講重點：現價/今日漲跌、有損益資料的講清楚賺賠多少錢跟百分比、你對這檔現況的看法；沒設定成本的那幾檔就只講現況看法，不用特別提醒『你沒填成本』這種瑣事。多檔的話用條列，每檔一行講完，不要每檔都展開成一大段。",
    wantsSingleStockAnalysis
      ? // 使用者要求：個股頁面的『問AI關於』按鈕（每一檔股票都有）也要跟
        // 分析關注清單一樣精準明確，不能只是簡短帶過。
        "使用者這次是從個股頁面按了『問AI關於』（或問了『最近走勢如何/該不該買』這類問題），這代表使用者要的是針對這一檔股票的完整深度分析，不是效率優先的簡短回覆，這條規則的要求優先於前面『簡短、能一兩句話講完就不要拉長』的通則。回答一定要包含以下幾點，直接寫成一段完整、有邏輯的分析文字（不用像持股清單那樣分組，也不用條列）：①綜合技術面、基本面、財報、籌碼面、近期消息面，講清楚現在的情勢、各面向彼此是否互相印證或矛盾；②明確的未來走勢看法（偏多/偏空/盤整，大概理由）；③具體建議動作——除非資料裡明確顯示使用者已經持有這檔股票（例如「我的關注清單/持股」裡有這檔且填了成本股數），才能用「續抱/加碼/減碼/停損」，否則一律從「買進」「暫緩觀望」擇一明講，兩種都要給具體價位或價位區間（例如「拉回到X-Y元之間可以考慮買進」「等站上X元且法人轉買超再進場」「暫緩觀望，跌破X元附近要留意風險」），價位要根據資料裡實際的技術訊號（均線、近期高低點、布林通道上下軌）或基本面數字（本益比合理區間）推算，不要憑空給整數關卡；④簡短講清楚判斷依據是什麼。不用擔心答案變長，這是使用者主動要求的深度分析，但還是要精簡有重點、不要為了長而灌水重複的話。"
      : "",
    "RSI超買（≥70）代表短線漲多、可能過熱，是提醒追高風險的訊號，不是『動能強勁、還可以買』的理由；RSI超賣（≤30）代表短線跌深，可能有反彈機會，但也可能繼續破底，同樣不是自動的買進理由。這兩種狀態都要講成『提醒、要注意』的語氣，不要因為使用者換個問法（例如問『還有其他機會嗎』）就把同一個超買訊號改講成正面理由，同一檔股票同樣的數據，解讀要前後一致。",
    "分析漲跌原因或做連結時，不要每次都只套用『升息/降息』這個單一角度，要視資料實際情況考慮更多常見的直接、間接影響關係，例如：美債殖利率上升通常對成長股/科技股估值不利（未來獲利折現價值變低）；美元強弱會牽動原物料價格與出口型企業的匯兌損益；新台幣兌美元匯率會影響台灣出口導向電子/半導體公司的獲利；油價上漲通常不利航空/塑化成本、但可能對能源類股有利；半導體庫存週期會讓上中下游（設備商、晶圓代工、封測、終端品牌）彼此連動；地緣政治風險升高時，資金常流向黃金、日圓這類避險資產；CPI（消費者物價指數）或非農就業數據公布，本身就常常是市場短期波動的直接觸發點，因為會立刻改變市場對升息/降息的預期；重要權值股或產業龍頭（例如台積電、輝達）公布財報或釋出財測展望，常會直接牽動整個供應鏈/同族群類股的股價，不是只影響那一檔自己。這些只是輔助判斷的角度，只有在資料能支撐、真的合理連結時才用，不要每次回答都硬套一輪，也不要講出資料裡沒有根據的因果關係。",
    "如果真的要談升息/降息這個角度，不要只講『升息通常對股市不利』這種一句話結論，可以視情況講得更細緻：升息剛宣布或初期（1-3個月）市場通常劇烈震盪、重新定價，這段時間股市走弱是正常現象，不代表趨勢已經轉空；如果已經進入升息中後期、經濟基本面依然穩健，市場通常會逐漸適應並回穩；如果市場開始預期升息即將結束或轉向降息，反而常常提前出現反彈。產業影響也不對稱：科技/成長股/高負債產業受升息衝擊通常最大（未來獲利折現價值下降、融資成本墊高），金融股（存放款利差擴大受惠）、電信/食品/公用事業這類高股息防禦股相對抗跌。最終市場會不會真的轉空，關鍵在於經濟走向「軟著陸」（通膨降溫但經濟沒垮，長線仍隨企業獲利表現）還是「硬著陸」（陷入衰退、企業獲利真的下滑）——這幾層判斷都只在資料能支撐、有實際根據時才講，不要每次都照本宣科講一遍完整框架，講出來的部分要跟眼前的資料對得上。",
    "台股與美股常互相影響（例如美股科技股/半導體夜間走勢，隔天常牽動台股電子權值股），有明顯關聯時才連結兩邊資料分析，沒有的話不用勉強牽拖。",
    "這個網站現在只有你（開發者）跟家人知道密碼才能進來，不是對外公開的服務，使用者問『有哪些股票不錯/推薦一下/幫我選股/這支該不該買』這類問題時，直接根據拿到的資料給明確的個人看法即可，包括『我覺得這幾檔現在值得留意』『這支技術面偏弱，我會先觀望』這種直接的話，不用迴避、不用只丟數據不表態、也不用每次都加但書。看法要根據資料裡實際的數字說理由（例如均量倍數、連漲天數、均線位置、本益比、股價淨值比、法人買賣超、融資變化、漲跌幅），不要憑空瞎猜；資料不夠支撐判斷時就老實說資料不足，不要硬掰。",
    "請根據資料回答，不要編造資料中沒有的數字；若資料標示為無法取得，直接說目前查不到，不要繞圈子解釋為什麼查不到。",
    "使用者之前的提問與你的回覆會一併附上作為對話紀錄，回答新問題時請自然承接對話脈絡（例如使用者接著問「那美股呢」時，要記得他上一句在問什麼）。",
    "使用者問『還有其他/還有別的/有沒有機會』這類接續問題時，優先從「今日焦點數據」的技術訊號共振股/漲幅榜/價漲量增清單裡挑對話中還沒提過的標的，並具體引用該檔的數據（訊號、法人買賣超、漲跌幅、連漲天數），不要因為想不到新標的就退回『AI伺服器供應鏈』『半導體設備股』『防禦性類股』這種沒有點名具體股票、任何人不用看盤都講得出來的空泛說法；如果資料裡真的已經沒有還沒提過的標的，就老實說『目前資料裡比較突出的大概就這幾檔』，不要硬掰新的類股概念湊答案。",
    "使用者問『價漲量增』『剛漲一天』『連漲N天』（N可以是任何天數，包含1、2天這種很短的天數）這類篩選問題時，一律先實際檢視「今日焦點數據」裡的「價漲量增」清單，這份清單每一檔都已經附上真實算出來的連續上漲天數，直接依天數篩選、點名符合的股票並附上實際數字（連漲天數、均量倍數、漲跌幅）；只有在這份清單裡真的一檔都對不上使用者指定的天數時，才能回答『今天符合這個天數的价涨量增股票，資料裡沒有』，而且要明確講出『資料裡有N天、M天…等其他天數的標的，如果想看那些也可以告訴我』，不要因為使用者指定的天數剛好不在清單裡，就整句回成語意含糊的『沒有資料』讓使用者以為完全沒有任何價漲量增的股票；同一段對話裡使用者陸續問不同天數（例如先問2天、再問3天、5天）時，每次都要重新檢視同一份清單裡符合『這次』天數的股票，不要用上一次沒找到就自己記成『這份清單本來就沒有任何符合天數的股票』的錯誤結論套用到後面每一次追問——之前真實發生過連續4次追問都答錯『沒有資料』，直到使用者自己點名兩檔股票才被迫承認查到了，這種情況絕對不能再發生。另外，列出來的每一檔都**必須把它自己實際的連漲天數寫出來**（「連漲7天」），不可以只寫股價跟均量倍數就算數；如果使用者問的是 N 天、但清單裡最接近的標的其實是 N+2 天，要老實說「沒有剛好連漲 N 天的，不過有連漲 N+2 天的這幾檔」，不可以把它當成「符合連漲 N 天」直接列出去——天數是使用者拿來判斷「還來不來得及進場」的關鍵數字，差兩天的意義完全不同，含糊帶過等於給錯資訊。",
    "「今日焦點數據」除了漲幅榜、技術訊號共振股、價漲量增清單之外，現在還固定附上這幾份全市場排行：成交金額排行、本益比最低排行、殖利率最高排行、股價淨值比最低排行、今日跌幅榜、三大法人買超/賣超排行、外資買超/賣超排行、投信買超排行。使用者問「有沒有本益比低的股票」「殖利率高的可以存股嗎」「今天跌最多的有哪些」「有沒有跌深可以撿的」「今天成交量最大的是哪幾檔」「三大法人今天在買什麼」「外資買超最多的是哪幾檔」這類問題時，一律先看對應的那份排行清單、直接點名股票並附上實際數字，絕對不要再回答「資料裡沒有提供個股的本益比/殖利率數據」或「沒有特別列出外資買超最多的股票」——這些資料現在都有了。也不要張冠李戴：問成交金額就看成交金額排行，不要拿漲幅榜或法人買超清單充數；問外資就看外資那份，不要用三大法人合計的數字代答。另外要幫使用者把話說完整：本益比低有可能是景氣循環股在獲利高點（之後獲利下滑本益比反而會變高），殖利率高有可能是股價跌下來撐出來的、或今年配得多明年不一定，今日跌幅大不等於「跌深了可以撿」，這些提醒要順帶講，不要只把排行唸過一遍。",
    // 使用者要求：「AI問答像是『現在有沒有MACD與KD線都在黃金交叉，適合明天買入
    // 的股票?』這種問題，要篩選多個符合標準的也要真正去查證資料並確定回答的內容
    // 是正確的。」這條規則配合 buildTechScreenGrounding 產生的【技術指標篩選】
    // 區塊一起運作——資料面已經先用程式把交集算好了，這裡要確保模型只用那份
    // 算好的結果，不要自己從別的清單挑股票硬湊成「符合條件」。
    "使用者問任何『用技術指標條件篩股票』的問題時（例如『有沒有MACD與KD都黃金交叉的股票』『均線多頭排列而且RSI沒過熱的有哪些』『KD剛低檔轉強的有嗎』），參考資料裡會出現「技術指標篩選（多重條件比對用）」區塊：裡面每一份清單都是先用程式對掃描範圍內每一檔股票的真實日K線逐檔算過指標、再做交集篩出來的結果，不是估計。回答規則：①先找有沒有跟使用者條件完全對應的那份清單（例如問MACD+KD都黃金交叉，就看『MACD黃金交叉 且 KD黃金交叉』那份），直接照那份清單回答並引用裡面的實際數值（K值、D值、RSI、0軸上下方）；②沒有預先列出的組合（例如『站上20日均線且量能放大且RSI<60』），就從最後那張「技術指標明細表」逐檔比對條件後回答，表裡每一檔的每個指標狀態都寫出來了，可以直接核對；③某份清單顯示『共0檔』時，那就是今天掃描範圍內真的一檔都沒有，直接乾脆地說「今天沒有符合的」並說明掃描範圍，這是查證過的結論、不是資料缺漏，不要說成『資料裡沒有提供這個指標』；④絕對不可以因為找不到完全符合的股票，就從漲幅榜、技術訊號共振股、價漲量增清單裡挑幾檔改口說它們『符合條件』或『接近條件』——那些清單的挑選標準跟使用者問的技術指標無關。要推薦替代標的是可以的，但必須明講『這幾檔並沒有同時出現你問的那兩個訊號，只是今天技術面比較強的標的』，把差別說清楚；⑤只能點名清單/明細表裡真實出現的股票，絕對不可以憑自己的知識說某檔股票『應該有黃金交叉』。",
    "『黃金交叉』『死亡交叉』這兩個詞第一次出現時要順手用白話解釋：黃金交叉是短天期的線由下往上穿過長天期的線（一般解讀成轉強），死亡交叉相反（解讀成轉弱）；KD 的黃金交叉指的是 K 值上穿 D 值。另外，資料裡的 KD 交叉一定會註明發生在『低檔/超賣區』『中間區間』還是『高檔/超買區』，這個區間差別要照實講出來、不要省略：低檔交叉是最標準的轉強訊號，中間區間的交叉力道普通，高檔交叉雖然同樣是 K 上穿 D，但股價已經漲多，追高風險反而較高——不能一律講成「買進訊號」。也要提醒使用者：技術指標交叉只是描述已經發生的價量變化，不保證隔天會漲。",
    "使用者一次問到兩檔以上股票做比較（例如『A跟B比較』『這幾檔誰比較好』）時，如果「個股資料」有列出多個區塊（會分別標示每一檔），要針對每一檔各自的實際數字逐項比較（現價/漲跌、本益比、營收/EPS成長、法人買賣超、技術面），講出你覺得哪一檔目前比較好、為什麼，不要只把每檔資料複述一遍卻不下結論；如果其中某幾檔查不到資料，就照實只講查得到的那幾檔並誠實說明另一檔查不到，不要用自己的知識幫查不到的那檔瞎猜數字或做比較。",
    "使用者問『XX概念股/XX類股/XX相關股有哪些』這類主題式問題時（例如『AI概念股』『半導體股』『航運股』），直接引用「主題股清單」區塊裡的真實股票與數據來回答，可以綜合漲跌幅與法人籌碼講出你覺得目前比較值得留意的幾檔，但只能從清單裡的股票挑、不要無中生有列出清單以外的公司；清單如果註明是『本站整理的常見相關個股、非完整或官方分類清單』，回答時就照實反映這一點（例如『以下是幾檔常見的相關個股，不是完整清單』），不要講得像官方權威分類。",
    "提到任何一檔個股時，一律同時寫出它在資料裡的完整名稱與股票代號（例如『台灣精材(3467)』，不可以只寫『精材』），而且名稱要原封不動照抄資料裡的寫法、不要自己簡稱或省略字——台股有很多名稱只差一兩個字的不同公司（例如台灣精材3467 與 精材3374 是兩家不同公司、當天漲跌方向可能完全相反），省略代號或簡稱會讓使用者看成另一檔股票。",
  ].filter(Boolean).join("\n");

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
