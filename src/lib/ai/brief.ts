import { cached } from "@/lib/data/cache";
import { AI_SWR_MS } from "@/lib/data/swrPolicy";
import { getIndices, getTaifexNightFutures, searchStocks, getMultiSignalStocks, getChips, getChipsRatiosBatch, getMacroSnapshot } from "@/lib/data";
import { buildMarketOverviewText } from "./marketOverview";
import { RULE_MACRO_DATA_COMPACT, RULE_COPY_NUMBERS_EXACTLY, RULE_ZH_TW_ONLY, RULE_CLOSED_DAY_WORDING } from "./compactRules";
import {
  GLOSS_FOREIGN_HOLDING,
  GLOSS_MAJOR_HOLDERS,
  GLOSS_MARGIN_UTILIZATION,
  GLOSS_SHORT_UTILIZATION,
  RULE_HOLDING_STRUCTURE_WORDING,
  RULE_SHORT_UTILIZATION_MEANING,
  holdingStructureCompact,
} from "./chipsRatiosWording";
import { fetchNews, fetchUsMarketNews } from "@/lib/data/news";
import { formatSharesWithLots } from "@/lib/format";
import { callAiProviders } from "@/lib/ai/provider";
import { archiveBrief } from "./briefArchive";
import { getMarketRegime } from "./learning/regimeData";
import { REGIME_LABEL } from "./learning/regime";
import { modelInfo, type ModelInfo } from "./modelName";
import { getMarketStatus, marketStatusLabel, weekendNoteForAi } from "@/lib/marketStatus";

export interface DailyBrief {
  text: string;
  usedAi: boolean;
  generatedAt: string;
  /** 產生這份快報的模型（AI 失敗走資料整理時沒有） */
  model?: ModelInfo;
}

// Originally date-keyed and cached for ~25h (generated once each morning by
// api/cron/daily-brief, before TW market open) so it read as a stable "daily"
// wrap instead of rolling every 20 minutes like actionBrief.ts. In practice
// that meant the whole day's content — including "台股加權指數今日..." —
// was frozen at whatever the market looked like around 08:50am, before the
// TW session even opened, and stayed stuck there (both the content and the
// "更新於 08:50" timestamp shown in DailyBriefCard) through the entire TW
// session, the US session that evening, and every actual market move in
// between. A user reported the displayed update time looking stale for
// exactly this reason.
//
// Switched to a plain rolling TTL (like actionBrief.ts) so the content
// actually catches up with the day as it happens instead of one frozen
// morning snapshot. First set to 3 hours (this prompt is bigger/more
// expensive than actionBrief's, ~550-800 words vs 200-350, so refreshing
// every 20 minutes felt wasteful) — then tightened to the site-wide 5-min
// 2026-09-20：從5分鐘拉長回30分鐘——這裡曾經從3小時改成5分鐘是為了跟全站快取
// 標準看齊，但快報是給人一天看幾次的摘要性內容，且每次重算都要真的呼叫一次
// 外部AI（成本、延遲都不小），5分鐘的 warm-cache 排程若每次都重算，是 Vercel
// 用量吃緊後盤點出來的浪費源頭之一，理由同 lib/data/index.ts 的 FUNDAMENTALS_TTL_MS
// 說明；30分鐘仍然遠比3小時的舊版本新鮮很多。
// 2026-10-04：使用者要求縮短為10分鐘（輸出改精簡格式後單次AI成本也較低）。
const BRIEF_TTL_MS = 10 * 60_000;
// v2: dropped the per-date key when this moved to a rolling TTL；v3：參考資料新增大戶／外資／融資比例區塊
// v4：2026-10-04 輸出改成精簡格式（一句總結＋台美分開條列＋一句風險），作廢舊的長篇快取
// v5：持股結構資訊行加上券資比；v6：第四項改成融券使用率（融券÷融券限額）
// v7：2026-10-05 補「同一個數字只寫一次」規則（BRIEF_RULE_NO_REPEAT_NUMBER），作廢舊快取
// v8：2026-10-05 快報改成「今日重點＋現象→原因→後續＋明天要留意」600~900字（使用者嫌太簡短、沒因果）
const BRIEF_CACHE_KEY = "daily-brief:v8";

function listStocks(items: Array<{ name: string; symbol: string; changePercent: number }>): string {
  return items.map((i) => `${i.name}(${i.symbol})：${i.changePercent >= 0 ? "+" : ""}${i.changePercent}%`).join("、");
}

// Chip data is only fetched for a handful of the day's biggest TW movers
// (not the whole market) — it's meant to give the brief a "why" behind the
// headline numbers (was a mover institution-driven or not), not to be a
// comprehensive chip-flow report on its own.
const CHIP_MOVERS_LIMIT = 5;

async function buildTwChipsSummary(
  twGainers: Array<{ name: string; symbol: string }>,
  twLosers: Array<{ name: string; symbol: string }>
): Promise<string> {
  const targets = [...twGainers.slice(0, CHIP_MOVERS_LIMIT), ...twLosers.slice(0, CHIP_MOVERS_LIMIT)];
  const lines = await Promise.all(
    targets.map(async (s) => {
      const chips = await getChips(s.symbol, "TW").catch(() => null);
      if (!chips?.institutionalNetShares) return null;
      return `${s.name}(${s.symbol})：三大法人${formatSharesWithLots(chips.institutionalNetShares)}`;
    })
  );
  const filtered = lines.filter((l): l is string => l !== null);
  return filtered.length > 0 ? filtered.join("\n") : "（今日主要漲跌個股無明顯法人籌碼資料）";
}

// 「主要漲跌個股的大戶／外資／融資比例」區塊：對象＝已經列在漲跌榜前 N 的台股（不另外
// 擴大名單），資料來自 getChipsRatiosBatch 的全市場整包快取，只在記憶體查表、不多打上游。
// 每檔一行、只帶本期＋前期變化，控制 AI 輸入長度；三項都查不到的（ETF、興櫃常見）直接略過。
const MOVERS_LIST_LIMIT = 8;

async function buildTwHoldingStructureSummary(
  twGainers: Array<{ name: string; symbol: string }>,
  twLosers: Array<{ name: string; symbol: string }>
): Promise<string> {
  const targets = [...twGainers.slice(0, MOVERS_LIST_LIMIT), ...twLosers.slice(0, MOVERS_LIST_LIMIT)];
  const ratios = await getChipsRatiosBatch(targets.map((s) => s.symbol)).catch(() => null);
  const lines = targets
    .map((s) => {
      const text = holdingStructureCompact(ratios?.get(s.symbol) ?? null);
      return text ? `${s.name}(${s.symbol})：${text}` : null;
    })
    .filter((l): l is string => l !== null);
  return lines.length > 0 ? lines.join("\n") : "（今日主要漲跌個股查無大戶／外資持股／融資／融券資料）";
}

// ── 今日快報系統提示詞（具名常數，見 CLAUDE.md 規則九）──
// 2026-10-04 使用者要求「更精簡且明確」：從四段 550-800 字（實測常寫到 2,000-2,900 字）
// 改成「一句總結＋台美分開條列＋一句風險」。精簡的是輸出與提示詞冗餘，誠實守則全部保留、改寫成短句。

const BRIEF_ROLE = "你是股票研究網站的「今日市場快報」撰稿人，用台灣繁體中文寫給忙碌的讀者，讓他30秒看完就掌握今天台股、美股發生什麼事。";

// 2026-10-05 使用者回報「快報太簡短、抓不到重點，要分析前因後果，也作為 AI 學習資料」：
// 字數從 ≤500 放寬到 600~900，結構改成「今日重點＋台股／美股各自『現象→原因→後續』＋明天要留意」。
// 這次問題不在字數本身，而是只列資訊沒有重點與因果；所以規則重點是每點固定三段式。
const BRIEF_FORMAT = [
  "【輸出格式，嚴格照這個骨架，不要多加段落】",
  "**今日重點**：1~2句，講今天市場最重要的一件事，以及它對下一個交易日的意義。",
  "**台股：發生了什麼、為什麼**",
  "- 2~3點（資料充足寫3點）。每點固定三段：先寫現象（帶關鍵數字，例如指數或個股漲跌幅、法人買賣超），再接『原因：』（只能用參考資料能支撐的：美股／費半前一晚、法人買賣、產業或公司新聞、總經、油價、匯率；因果用『可能／通常』），最後接『後續：』（這個現象的影響，或接下來要看什麼）。",
  "**美股：發生了什麼、為什麼**",
  "- 1~2點，同樣三段式（現象帶數字 → 原因： → 後續：）。",
  "**明天要留意**",
  "- 1~2點，寫具體要看的指標或價位，例如『加權若守住48,000點』『留意外資是否續買』；價位與數字只能來自參考資料，不可自己編支撐壓力。",
  "每一點用 - 開頭、單獨一行，三段在同一點內以句號分開；每點（現象＋原因＋後續三段合計）台股不超過130字、美股不超過110字，明天要留意每點不超過60字，今日重點不超過90字；資料充足時台股寫3點、美股寫2點，資料不足才減少；全文（含數字）約650~900字，不要超過1000字。",
  "資料裡找不到原因時，原因欄寫『原因不明』或整點略過，不可為了湊結構硬編理由。",
  "不要開場白、不要結尾總結或客套、不要免責聲明（網站會自動附上），不要用 # 標題。",
].join("\n");

const BRIEF_RULE_CONTENT =
  "每點挑當天最重要的事（大盤走勢、最大漲跌族群或個股），不要逐檔列清單，要讓讀者讀完知道『發生什麼、為什麼、接下來看什麼』。原因只在新聞、籌碼、總經或前一晚美股資料能支撐時才寫，因果用『可能／通常』，不可寫成肯定句；沒有明顯關聯就寫『原因不明』、不要牽拖；台美連動（前一晚美股／費半對台股、台股收盤對美股）有資料支撐才提。『今日重點』必須與下面條列的數字一致，且不可只是把條列再抄一遍。";

// 2026-10-05 本機實測：備援模型（Nemotron）把「陽程+787張」寫成「法人賣超」、自己編「選前樂觀預期」「估值偏高」
// 「浩鼎為電子相關」這類資料裡沒有的原因，全文也寫到1,100字。原因欄最容易編造，所以獨立成具名規則。
const BRIEF_RULE_CAUSE_GROUNDING =
  "『原因：』每一句都必須能在參考資料裡找到出處（某則新聞標題、某個總經或指數數字、某項法人買賣超）；找不到就寫『原因不明』。不可自己編題材、估值判斷、選舉或政策預期，不可自行推斷公司業務屬於哪個產業。個股法人買賣超的正負號與張數逐檔照抄（正數＝買超、負數＝賣超），不可寫成相反方向，同一句裡買超與賣超的個股不可歸為同一種方向。台股條列以大盤、法人、產業主題為主，『後續』提到的價位、關卡也只能用參考資料裡出現過的數字（台指期、前高前低、均線等），不可自己編整數關卡或支撐壓力；解釋指數或族群漲跌時，不可編造資料沒提到的細節（例如哪類股拖累、哪個子產業表現參差）。個股只在有新聞或籌碼資料能說明時才提，不要為了湊點數逐檔講漲停股，也不要把一串個股塞進同一點。技術訊號只在『原因』有直接關聯時才提，且只能引用資料列出的訊號名稱。";

const BRIEF_RULE_MARKET_STATUS =
  "依【市場狀態】描述數字：已收盤才可用『收在／終場／收盤』；盤中絕對不可用這些字，改用『目前／盤中來到』。台股、美股各依自己的狀態，不互相套用。";

const BRIEF_RULE_NO_ADVICE =
  "只描述現象，不給買賣／加減碼建議或目標價，不用『值得買』『即將噴出』這類預測字眼；技術訊號只描述現狀，RSI超買是『漲多警訊』不是利多。";

const BRIEF_RULE_HONESTY =
  "只用參考資料裡的真實數字與名稱（資料沒出現的股票、數字、事件一律不寫），股數換算的張數直接照抄；資料標示無法取得就寫『無資料』或略過，不可編造。大盤概況沒有某指數的當日報價就寫『今日指數無資料』，不可拿台指期或歷史走勢代替當日漲跌；總結必須跟條列數字一致，指數無資料的市場不可說它漲或跌。美股沒有法人籌碼資料是資料源限制，不是抓取失敗。";

// 2026-10-04 Opus 正式站複查：快報把指數 48,4xx 點的小跌寫成「收跌0.48萬點」（讀者會以為跌了4,800點），
// 也把「近5日合計賣超、最近3日轉買」寫成矛盾的「近5日-401億（連買3日）」。
const BRIEF_RULE_NUMBERS =
  "數字照參考資料原樣寫：指數點位寫完整點數（例如『48,417點』），漲跌寫點數加百分比（例如『跌58點（-0.12%）』），不可改寫成『萬點』或自行換算單位。法人『近N日合計』與『連買／連賣M日』方向不同時，要寫成『近N日合計賣超X億，但最近M日已轉為買超』，不可並列成看似矛盾的一句。";

// 2026-10-05 正式站：快報寫出「外資近5日雖賣超401.3億、近5日外資-401.3億」——參考資料【市場歷史】只列一次
// （marketHistoryText.ts describeInstitutional），是模型自己換句話重複，所以從規則端禁止。
const BRIEF_RULE_NO_REPEAT_NUMBER =
  "同一個數字（同一項目、同一期間）全文只寫一次，不可在同一句或不同點換句話重複（例如不可寫『外資近5日賣超401.3億、近5日外資-401.3億』）。";

// 今日快報對「持股結構」三項的措辭規則（共通的週資料／照抄升降規則在 RULE_HOLDING_STRUCTURE_WORDING）。
const BRIEF_RULE_HOLDING_STRUCTURE = `大戶／外資持股／融資／融券比例只能當解釋台股漲跌的線索之一，不可推論未來漲跌。第一次提到時括號帶過：${GLOSS_MAJOR_HOLDERS}、${GLOSS_FOREIGN_HOLDING}、${GLOSS_MARGIN_UTILIZATION}、${GLOSS_SHORT_UTILIZATION}。${RULE_HOLDING_STRUCTURE_WORDING}${RULE_SHORT_UTILIZATION_MEANING}`;

const BRIEF_SYSTEM_PROMPT = [
  BRIEF_ROLE,
  BRIEF_FORMAT,
  BRIEF_RULE_CONTENT,
  BRIEF_RULE_CAUSE_GROUNDING,
  BRIEF_RULE_MARKET_STATUS,
  BRIEF_RULE_NO_ADVICE,
  BRIEF_RULE_HONESTY,
  BRIEF_RULE_NUMBERS,
  BRIEF_RULE_NO_REPEAT_NUMBER,
  RULE_COPY_NUMBERS_EXACTLY,
  RULE_ZH_TW_ONLY,
  RULE_CLOSED_DAY_WORDING,
  RULE_MACRO_DATA_COMPACT,
  BRIEF_RULE_HOLDING_STRUCTURE,
].join("\n");

export async function getDailyBrief(forceRefresh = false): Promise<DailyBrief> {
  return cached(BRIEF_CACHE_KEY, BRIEF_TTL_MS, async () => {
    const [indices, taifexFutures, macro, twGainers, usGainers, twLosers, usLosers, twMomentum, usMomentum, twNews, usNews] =
      await Promise.all([
        getIndices(),
        getTaifexNightFutures().catch(() => null),
        getMacroSnapshot(),
        searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" }),
        searchStocks({ market: "US", sortBy: "changePercent", sortDir: "desc" }),
        searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "asc" }),
        searchStocks({ market: "US", sortBy: "changePercent", sortDir: "asc" }),
        getMultiSignalStocks("TW"),
        getMultiSignalStocks("US"),
        // Deliberately more than the chat's per-question news limit — Google
        // News' feed for a broad query like "台股"/"美股" naturally spans the
        // last several days, not just today, which is what lets the model
        // write the "近期重點" section below instead of just restating
        // today's numbers a second time.
        fetchNews("台股", 15).catch(() => []),
        fetchUsMarketNews(10).catch(() => []),
      ]);
    const [chipsSummary, holdingSummary] = await Promise.all([
      buildTwChipsSummary(twGainers, twLosers),
      buildTwHoldingStructureSummary(twGainers, twLosers),
    ]);

    const twStatus = getMarketStatus("TW");
    const usStatus = getMarketStatus("US");

    const grounding = [
      `【市場狀態】台股目前${marketStatusLabel(twStatus)}；美股目前${marketStatusLabel(usStatus)}（美股與台股交易時段不重疊，寫美股段落時以美股自己的狀態為準，不要套用台股的狀態）${weekendNoteForAi() ? `；${weekendNoteForAi()}` : ""}`,
      "",
      "【大盤概況（台股＋美股）】",
      buildMarketOverviewText(indices, taifexFutures, macro),
      "",
      `【台股漲幅前${MOVERS_LIST_LIMIT}】`, listStocks(twGainers.slice(0, MOVERS_LIST_LIMIT)),
      `【台股跌幅前${MOVERS_LIST_LIMIT}】`, listStocks(twLosers.slice(0, MOVERS_LIST_LIMIT)),
      "",
      "【美股漲幅前8】", listStocks(usGainers.slice(0, 8)),
      "【美股跌幅前8】", listStocks(usLosers.slice(0, 8)),
      "",
      "【台股技術訊號共振股（同時符合2個以上客觀技術訊號，如爆量、站上均線、連漲）】",
      twMomentum.length > 0
        ? twMomentum.slice(0, 6).map((i) => `${i.name}(${i.symbol})：${i.signals.map((s) => s.label).join("、")}`).join("\n")
        : "（今日無）",
      "【美股技術訊號共振股】",
      usMomentum.length > 0
        ? usMomentum.slice(0, 6).map((i) => `${i.name}(${i.symbol})：${i.signals.map((s) => s.label).join("、")}`).join("\n")
        : "（今日無）",
      "",
      "【今日主要漲跌個股的三大法人籌碼動向（僅台股，股數已換算好對應張數，直接引用不要自己重算）】",
      chipsSummary,
      "",
      "【主要漲跌個股的大戶／外資／融資／融券比例（僅台股，附前期變化；大戶是集保每週公布的週資料、跟上一週比，外資持股、融資使用率與融券使用率是每日資料、跟前一交易日比；升降幅度已算好，直接引用）】",
      holdingSummary,
      "",
      "【近期市場新聞（台股，依時間排序，可能橫跨最近幾天）】",
      twNews.length > 0 ? twNews.map((n) => `- [${n.pubDate.slice(0, 10)}] ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n") : "（無法取得）",
      "【近期市場新聞（美股，中英文來源混合，依時間排序，可能橫跨最近幾天）】",
      usNews.length > 0 ? usNews.map((n) => `- [${n.pubDate.slice(0, 10)}] ${n.title}${n.source ? `（${n.source}）` : ""}`).join("\n") : "（無法取得）",
    ].join("\n");


    // Not on a path a user stares at a spinner for (cron / client-fetched),
    // so a longer timeout is fine. maxOutputTokens stays well above the ~600-900
    // character target: CJK costs more tokens per character than a naive
    // estimate (an old 550-800 char prompt got cut mid-sentence at 1600), and
    // a truncated answer makes the provider layer fail over to the next one.
    const result = await callAiProviders(BRIEF_SYSTEM_PROMPT, [{ role: "user", content: `參考資料：\n${grounding}` }], {
      timeoutMs: 30000,
      totalBudgetMs: 38000, // 資料抓取最久約 10~15 秒＋這段＜maxDuration 60 秒，否則整個函式被 Vercel 砍掉（2026-10-05 實測 refresh 逾時）
      maxOutputTokens: 6000,
    });

    if (result.usedAi) {
      const generatedAt = new Date().toISOString();
      // 存檔作為 AI 學習資料（不等待、失敗不影響快報；一天最多寫 2 次，見 briefArchive.ts）
      const regime = await getMarketRegime().catch(() => null);
      archiveBrief({ text: result.answer, generatedAt, model: result.model ?? null, regime: regime ? REGIME_LABEL[regime] : null, grounding });
      return { text: result.answer, usedAi: true, generatedAt, model: modelInfo(result.model) };
    }

    // AI 掛掉時的資料整理，跟 AI 版同一種骨架（今日重點／台股／美股／明天要留意），只放客觀數字。
    const pctText = (n: number) => `${n >= 0 ? "+" : ""}${n}%`;
    const fallbackMarket = (
      label: string,
      market: "TW" | "US",
      gainer?: { name: string; symbol: string; changePercent: number },
      loser?: { name: string; symbol: string; changePercent: number }
    ) => {
      const idx = indices.filter((i) => i.market === market);
      return [
        `**${label}**`,
        `- 指數：${idx.length > 0 ? idx.map((i) => `${i.name} ${pctText(i.changePercent)}`).join("、") : "無資料"}`,
        `- 漲幅居首：${gainer ? `${gainer.name}(${gainer.symbol}) ${pctText(gainer.changePercent)}` : "無資料"}；跌幅居首：${
          loser ? `${loser.name}(${loser.symbol}) ${pctText(loser.changePercent)}` : "無資料"
        }`,
      ];
    };
    const fallback = [
      `**今日重點**：AI 快報暫時無法產生（${(result.failureReason ?? "未知原因").replace(/。$/, "")}），以下為原始數字整理。`,
      ...fallbackMarket("台股", "TW", twGainers[0], twLosers[0]),
      ...fallbackMarket("美股", "US", usGainers[0], usLosers[0]),
      "**明天要留意**：以上未經綜合分析，僅供參考。",
    ].join("\n");

    return { text: fallback, usedAi: false, generatedAt: new Date().toISOString() };
  }, { forceRefresh, staleWhileRevalidateMs: AI_SWR_MS });
}
