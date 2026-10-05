import { cached } from "@/lib/data/cache";
import { AI_SWR_MS } from "@/lib/data/swrPolicy";
import { callAiProviders } from "@/lib/ai/provider";
import { buildActionGrounding } from "./actionGrounding";
import { getTradingStance, type BriefMode, type TradingStance } from "./tradingStance";
import type { RatingCode } from "./siteRating";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import {
  HOLDING_STRUCTURE_FACET_NAME,
  QUALIFY_MAX_AGAINST,
  QUALIFY_MIN_SUPPORT,
  SCORED_FACET_LABEL,
} from "./actionScoring";
import { RULE_MACRO_DATA_COMPACT, RULE_COPY_NUMBERS_EXACTLY, RULE_ZH_TW_ONLY, RULE_CLOSED_DAY_WORDING } from "./compactRules";
import {
  GLOSS_FOREIGN_HOLDING,
  GLOSS_MAJOR_HOLDERS,
  GLOSS_MARGIN_UTILIZATION,
  GLOSS_SHORT_UTILIZATION,
  RULE_HOLDING_STRUCTURE_WORDING,
  RULE_SHORT_UTILIZATION_MEANING,
} from "./chipsRatiosWording";

export interface ActionBriefPick {
  symbol: string;
  name: string;
  /** 本站綜合評等字樣（未持有），例如「建議等回檔再買（現價不買，等回到 120～125）」 */
  label: string;
  /** buy＝建議買進（A組）；buy-on-pullback＝等回檔（B組，現價不買） */
  code: RatingCode;
  holdingLabel: string;
  reason: string;
}

export interface ActionBrief {
  text: string;
  usedAi: boolean;
  generatedAt: string;
  /** 「今日建議」或「明日開盤建議」「下個交易日開盤建議」（依產生當下的時段，見 tradingStance.ts） */
  title: string;
  mode: BriefMode;
  /** 名單（程式依本站綜合評等決定，AI 問答全市場推薦也讀這份） */
  picks: ActionBriefPick[];
}

// 2026-09-20：拉長回 30 分鐘——這是一段給人「一天看幾次」的摘要性建議文字，
// 不需要分鐘級新鮮度；背後又疊了好幾個本來就很貴的資料源（技術訊號共振股要
// 抓K線、還要呼叫一次外部AI），5分鐘的 warm-cache 排程若每次都重算整段（含
// AI呼叫），是 Vercel 用量吃緊後盤點出來的浪費源頭之一，理由同
// lib/data/index.ts 的 FUNDAMENTALS_TTL_MS 說明。
// 2026-10-04：使用者要求縮短為 10 分鐘（輸出改精簡格式後單次 AI 成本也較低）。
const ACTION_BRIEF_TTL_MS = 10 * 60_000;

// ── 今日建議系統提示詞（具名常數，見 CLAUDE.md 規則九）──
// 2026-10-04 使用者要求「更精簡且明確」：輸出從 350-550 字（實測常到 1,100-1,250 字、每檔一大段）
// 改成每檔一個條列（結論＋2~3個關鍵數字＋一句風險）。精簡的是輸出與提示詞冗餘；下面每條
// 誠實守則／門檻規則都是實測踩過的坑（詳細來龍去脈見 git 歷史 2026-09-23 以前的版本），
// 只改寫成短句，不可以為了精簡刪掉。

const ACTION_ROLE_TODAY =
  "你是股票研究網站的「今日建議」撰稿人，讀者沒有金融背景、要30秒看完做決定。任務只有一個：直接講今天可以買哪幾檔、為什麼。這不是市場回顧（那是「今日市場快報」的工作）。";

// 2026-10-05 使用者要求：14:30 後到隔天開盤前（含週末）改成「明日開盤建議」，內容也要用開盤進場角度寫，不能只改標題。
function actionRoleNextOpen(stance: TradingStance): string {
  return `你是股票研究網站的「${stance.briefTitle}」撰稿人，讀者沒有金融背景、要30秒看完做決定。台股今天已收盤（或週末休市），下一次開盤是 ${stance.nextOpenLabel} 09:00。任務只有一個：用最新收盤後的資料，直接講「${stance.nextOpenLabel} 開盤」可以買哪幾檔、怎麼進場。不可寫「今天可以買」「現在盤中」，進場條件要寫成開盤情境（例如「開盤若跳空高於X元不追，回到A～B元再分批」）。`;
}

// 「建議要直接，但門檻不能降」——放寬（推薦漲停股、法人賣超股）跟加嚴（AI 自己追加
// 「技術面也要支持」把合格標的全部排除、寫成觀望）兩個方向都實測發生過，兩邊都要講。
const ACTION_RULE_THRESHOLD = [
  "【門檻（硬性，不可放寬也不可加嚴）】",
  `- 只能從【建議名單】挑（已先過面向支持數 ≥${QUALIFY_MIN_SUPPORT}、明確不支持 ≤${QUALIFY_MAX_AGAINST}（${SCORED_FACET_LABEL}），再經本站綜合評等為「建議買進」或「建議等回檔再買」）。每檔結論一律照抄該檔【本站綜合評等】「未持有：」後面引號裡的字樣（含區間），不可改寫成別的結論——個股頁「問AI關於」讀的是同一份評等，兩邊必須一致。`,
  "- 【體質過門檻、但本站綜合評等為「建議先不要買」】的股票不可列進建議。",
  "- 【A組：建議買進】與【B組：等回檔】必須分成兩塊寫，不可混在同一個清單：B組每檔都要明講「現價不買，等回到 A～B 再分批」，不可寫成可以買、也不可放進建議買進那塊（2026-10-05 檢討：使用者看到名單就直接買，等回檔的股票被追在高點）。各組最多 3 檔。",
  "- 籌碼面【不支持】（法人賣超）一律不可列入；不可只因漲停／漲最多／技術線漂亮就推薦。",
  "- RSI超買、觸及布林通道上緣是『漲多警訊』，不可當買進理由。",
  "- 名單不是空的就一定要列建議；不可自己追加「技術面也要支持」「全部面向都要支持」等條件，技術面沒訊號但其他面向支持的照樣列，理由裡誠實說技術面今天沒有夠強的訊號。",
  "- A組 0 檔但 B組有時，建議買進那塊寫一句「目前沒有現價可直接買的」＋原因，B組照列；【建議名單】兩組都是 0 檔才寫觀望，一句白話講原因（例如法人普遍在賣、體質過關的都已漲離買進區間、或台股資料今天查不到）；不可硬湊、不可編造股票或數字。",
].join("\n");

function actionFormat(stance: TradingStance): string {
  const nextOpen = stance.briefMode === "next-open";
  return [
  "【輸出格式，嚴格照這個骨架，只用 **粗體** 當小標、不用 # 標題】",
  nextOpen
    ? "**大盤**：一句白話講最近一個交易日收盤後的氣氛與下個交易日開盤要留意的方向（≤30字，不要堆指數數字；大盤概況沒有台股加權指數報價時，不可說台股漲跌或創新高）。"
    : "**大盤**：一句白話講今天氣氛（≤30字，不要堆指數數字；大盤概況沒有台股加權指數當日報價時，不可說台股漲跌或創新高）。",
  nextOpen ? `**${stance.nextOpenLabel} 開盤可買（建議買進）**` : "**建議買進（現價可分批買）**",
  nextOpen
    ? "- **名稱(代號)**：照抄評等字樣（「建議買進」）。開盤做法：一句，用評等裡的價位（例如「開盤若跳空高於C元不追，回到A～B元再分批」）。理由：2~3個最關鍵的數字，術語第一次出現要帶括號。風險：一句，只能根據體檢表裡的數字。"
    : "- **名稱(代號)**：照抄評等字樣（「建議買進」）。理由：只挑2~3個最關鍵的數字，術語第一次出現要帶括號（例：三大法人（外資、投信、自營商）買超6,592張、本益比（股價是年獲利幾倍）11.74倍）。風險：一句，只能根據體檢表裡的數字（例如技術面今天沒有夠強的訊號、融資使用率偏高）；評等理由有「短線波動風險」（急漲）時風險就寫這句（短線常回檔、宜分批）。",
  nextOpen ? "（只列A組，每檔一個條列、≤110字；A組 0 檔時這塊寫「- 開盤沒有可直接買的：一句原因」）" : "（只列A組，每檔一個條列、≤90字；A組 0 檔時這塊寫「- 目前沒有現價可直接買的：一句原因」）",
  `**${PULLBACK_GROUP_TITLE}**`,
  "- **名稱(代號)**：照抄評等字樣（例如「建議等回檔再買（現價不買，等回到 A～B）」）。一句理由（為什麼現價不買：漲多警訊／急漲／高於區間的數字）。（只列B組，每檔≤70字；B組 0 檔就整塊省略）",
  "**我的看法**：1~2句表達你自己的排序與把握（2026-10-05 使用者：AI 變太保守、不敢表達）：兩組合起來我最看好哪一檔、其次哪一檔、各為什麼（一個關鍵數字），等回檔的要寫觸發條件（回到 A～B 或站穩 C）；最後寫「把握程度：高／中／低」＋一句原因。不可推翻評等的動作結論（等回檔不可講成現在可買）。兩組都 0 檔就整塊省略。A、B 兩組內也依你看好的程度由高到低排列。",
  "**不建議追**：一句。從【今日台股漲幅榜前10】挑1檔體檢表裡也有、面向支持數0~1的，講它漲多少＋1~2個沒跟上的面向；漲幅榜前段體質都還可以就寫「漲幅榜前段體質大多說得過去」，不要硬挑；漲幅榜標示無資料就寫「今日漲幅榜無資料」。",
  "**留意**：一句要注意的風險（不是利多）。取材只能來自【近期重大消息】或上面的體檢結果，參考資料沒提到的總經事件一律不可寫。",
  "措辭不可暗示「照建議買會贏大盤」；網站頁首已說明本站評等回測未顯示穩定超越大盤，內文不用重複。",
  "全文不超過450字。不要開場白、客套、結尾延伸提問或免責聲明（網站會自動附上）；同一個數字不要重複講。",
  ].join("\n");
}

// 實測正式站出現過簡體「几倍」、日文漢字「同歩」，以及把正負號寫成「為加24.85%」「為負0.57元」。
const ACTION_RULE_WRITING =
  "全文用台灣繁體中文，不可出現簡體字或日文漢字（錯例：几倍、同歩）。數字一律阿拉伯數字＋符號（1.6%、3,800張、+24.85%、-0.57元），不寫中文數字或「加」「負」。語氣直接（「建議買進」），不用「值得留意」「僅供參考」「可能吧」這類模糊說法。";

// 術語解釋的實測坑：(1)沒附範例就整排裸奔；(2)同一句擠「本益比、股價淨值比、殖利率」時只解釋第一個；
// (3)在括號裡自己加過渡語寫出「本益比（股價淨值比等指標中，本益比代表…）」這種破碎句。
const ACTION_RULE_GLOSSARY = `【術語】第一次出現時在同一句用≤15字括號白話帶過，不另開段落；同一句有多個術語要各自解釋；括號裡直接放解釋、不加「簡單來說」「XX等指標中」之類過渡語。可照抄：三大法人（外資、投信、自營商）、外資（外國機構投資人）、投信（國內基金公司）、自營商（券商自營部門）、融資（借錢買股）、${GLOSS_MARGIN_UTILIZATION}、${GLOSS_SHORT_UTILIZATION}、${GLOSS_FOREIGN_HOLDING}、${GLOSS_MAJOR_HOLDERS}、買超／賣超（買進多於賣出／反之）、本益比（股價是年獲利幾倍）、股價淨值比（股價是淨資產幾倍）、殖利率（年股息占股價比例）、營收年增率（營收比去年同月成長）、每股盈餘（每股賺多少錢）、爆量（成交量暴增）、均線（過去N天平均價）、多頭／空頭排列（短均線在長均線上／下）、MACD（判斷趨勢轉強弱）、黃金交叉（短線上穿長線，轉強）、死亡交叉（短線下穿長線，轉弱）、KD（看短線過熱過冷）、RSI（0~100，越高漲越兇）、布林通道（股價正常波動區間）。交稿前逐一檢查每個術語第一次出現時有沒有括號解釋，漏了補上（這條優先於字數上限）。原始資料自帶的括號說明（例如「MACD黃金交叉（0軸上方…）」）照抄，不要把自己的解釋塞進同一個括號。`;

// 「持股結構面」在今日建議裡的專屬規則（措辭共通規則在 RULE_HOLDING_STRUCTURE_WORDING）。
const ACTION_RULE_HOLDING_STRUCTURE = `籌碼面＝三大法人今天買賣超幾張（流量）；${HOLDING_STRUCTURE_FACET_NAME}＝大戶／外資持股比例、融資使用率、融券使用率跟前期比的變化（存量），兩者不要混為一談。引用時帶實際數字，不寫「持股結構不錯」這種空話；標【無資料】就寫查不到，不可編數字。融資使用率偏高或單日急升是散戶槓桿升溫的追高風險，不可講成利多。融券使用率只列資訊不計分：${RULE_SHORT_UTILIZATION_MEANING}`;

const ACTION_RULE_DATA_HONESTY = [
  "技術面標【無資料】代表「今天沒有2個以上技術訊號同時成立」，要寫「技術面今天沒有夠強的訊號」，不可寫成「技術面無資料」。",
  "只用參考資料裡的真實數字與名稱，張數照抄不要重算。消息面範圍不可比資料大：資料只提到某一個央行就不可擴寫成「全球主要央行」，只提到某一家公司就不可擴寫成整個產業。",
  "美股沒有法人籌碼與持股結構公開資料，是資料源限制、不是抓取失敗。",
].join("\n");

function buildActionSystemPrompt(stance: TradingStance): string {
  return [
  stance.briefMode === "next-open" ? actionRoleNextOpen(stance) : ACTION_ROLE_TODAY,
  ACTION_RULE_THRESHOLD,
  actionFormat(stance),
  ACTION_RULE_WRITING,
  ACTION_RULE_GLOSSARY,
  ACTION_RULE_HOLDING_STRUCTURE,
  RULE_HOLDING_STRUCTURE_WORDING,
  ACTION_RULE_DATA_HONESTY,
  RULE_MACRO_DATA_COMPACT,
  RULE_COPY_NUMBERS_EXACTLY,
  RULE_ZH_TW_ONLY,
  RULE_CLOSED_DAY_WORDING,
  ].join("\n");
}

/** 等回檔那組的小標（AI 版與 fallback 共用，畫面上要明講現價不買）。 */
export const PULLBACK_GROUP_TITLE = "等回檔名單（現價不買，等回到區間再分批）";

/** 程式組的分組名單（AI 掛掉時的 fallback；兩組分開，等回檔那組明講現價不買）。 */
export function groupedPickLines(picks: ActionBriefPick[], stance: Pick<TradingStance, "briefMode" | "nextOpenLabel">): string[] {
  const nextOpen = stance.briefMode === "next-open";
  const buy = picks.filter((p) => p.code === "buy").slice(0, 3);
  const pullback = picks.filter((p) => p.code === "buy-on-pullback").slice(0, 3);
  const line = (p: ActionBriefPick) => `- **${p.name}(${p.symbol})**：${p.label}。理由：${p.reason}。`;
  const buyTitle = nextOpen ? `**${stance.nextOpenLabel} 開盤可買（建議買進）**` : "**建議買進（現價可分批買）**";
  if (buy.length === 0 && pullback.length === 0) {
    return [
      buyTitle,
      `- ${nextOpen ? "開盤先觀望" : "今天觀望"}：沒有個股同時通過${SCORED_FACET_LABEL}的體質門檻（至少 ${QUALIFY_MIN_SUPPORT} 項支持、不支持最多 ${QUALIFY_MAX_AGAINST} 項）且本站綜合評等為買進或等回檔。`,
    ];
  }
  return [
    buyTitle,
    ...(buy.length > 0
      ? buy.map(line)
      : [`- ${nextOpen ? "開盤沒有可直接買的" : "目前沒有現價可直接買的"}：體質過關的都已漲離買進區間或短線急漲，見下方等回檔名單。`]),
    ...(pullback.length > 0 ? [`**${PULLBACK_GROUP_TITLE}**`, ...pullback.map(line)] : []),
  ];
}

export async function getActionBrief(forceRefresh = false): Promise<ActionBrief> {
  const stance = getTradingStance();
  return cached(
    // v2：輸出格式從「3-5條值得留意的重點」改成「多面向驗證過的今日建議買進清單」，
    // 舊格式的快取內容跟新的頁面說明對不起來，換 key 直接作廢舊結果。
    // v3：體檢表新增「持股結構面（大戶／外資／融資）」，作廢舊快取。
    // v4：2026-10-04 輸出改成精簡格式（每檔一條：結論＋關鍵數字＋風險），作廢舊的長篇快取。
    // v5：體檢表持股結構面加上券資比；v6：第四項改成融券使用率（融券÷融券限額），作廢舊快取。
    // v7：2026-10-05 名單改由本站綜合評等決定（siteRating.ts），並依時段分「今日建議／明日開盤建議」——
    //     key 帶台北日期＋模式，盤中版本不會在 14:30 後（含 SWR 寬限期）被沿用成明日開盤建議。
    // v8：2026-10-05 名單分「建議買進／等回檔（現價不買）」兩組，picks 多了 code。
    // v9：2026-10-05 加「我的看法」排序與把握程度、措辭不暗示贏大盤。
    `action-brief:v9:${taipeiDayKey()}:${stance.briefMode}`,
    ACTION_BRIEF_TTL_MS,
    async () => {
      const { text: grounding, picks: ratedPicks, indexSummary } = await buildActionGrounding();
      const picks: ActionBriefPick[] = ratedPicks.map((p) => ({
        symbol: p.rating.symbol,
        name: p.rating.name,
        label: p.rating.rating.label,
        code: p.rating.rating.code,
        holdingLabel: p.rating.rating.holdingLabel,
        reason: p.rating.rating.reason,
      }));
      const base = { title: stance.briefTitle, mode: stance.briefMode, picks };

      // Not on a blocking user-wait path (client-fetched, not SSR-blocking).
      // maxOutputTokens stays well above the <=400 character target: CJK costs
      // more tokens per character than a naive estimate (see PROGRESS.md's
      // truncation-bug lesson), and a truncated answer makes the provider
      // layer fail over to the next provider rather than show a cut sentence.
      const result = await callAiProviders(
        buildActionSystemPrompt(stance),
        [{ role: "user", content: `參考資料：\n${stance.stanceLine}\n\n${grounding}` }],
        { timeoutMs: 25000, maxOutputTokens: 1200 }
      );

      if (result.usedAi) {
        return { ...base, text: result.answer, usedAi: true, generatedAt: new Date().toISOString() };
      }

      // AI 掛掉時：名單與結論本來就是程式依本站綜合評等算好的（不是 AI 判斷），可以照列；
      // 只是少了 AI 的白話理由，改列程式組好的一句理由摘要。
      const fallback = [
        `**大盤**：${indexSummary.replace(/^大盤：/, "")}`,
        ...groupedPickLines(picks, stance),
        `**留意**：AI 白話說明暫時無法產生（${(result.failureReason ?? "未知原因").replace(/。$/, "")}），以上為程式依各面向評分與價位算出的評等。`,
      ].join("\n");

      return { ...base, text: fallback, usedAi: false, generatedAt: new Date().toISOString() };
    },
    // 過期先回舊建議、背景重算（寬限期見 swrPolicy.ts），訪客不用現場等 AI。
    { forceRefresh, staleWhileRevalidateMs: AI_SWR_MS }
  );
}
