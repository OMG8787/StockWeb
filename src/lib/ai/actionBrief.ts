import { cached } from "@/lib/data/cache";
import { AI_SWR_MS } from "@/lib/data/swrPolicy";
import { callAiProviders } from "@/lib/ai/provider";
import { buildActionGrounding } from "./actionGrounding";
import { buildPlan, parseActionBriefJson, renderActionBrief, type ActionBriefPick } from "./actionPicks";
import { getAiJudgments } from "./aiJudge";
import { describeAiView, type AiJudgment } from "./learning/aiAdjust";
import { guardAnswerNumbers } from "./numberGuard";
import { getTradingStance, type BriefMode, type TradingStance } from "./tradingStance";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { HOLDING_STRUCTURE_FACET_NAME } from "./actionScoring";
import { RULE_MACRO_DATA_COMPACT, RULE_COPY_NUMBERS_EXACTLY, RULE_ZH_TW_ONLY, RULE_CLOSED_DAY_WORDING } from "./compactRules";
import {
  GLOSS_FOREIGN_HOLDING,
  GLOSS_MAJOR_HOLDERS,
  GLOSS_MARGIN_UTILIZATION,
  GLOSS_SHORT_UTILIZATION,
  RULE_HOLDING_STRUCTURE_WORDING,
  RULE_SHORT_UTILIZATION_MEANING,
} from "./chipsRatiosWording";

export interface ActionBrief {
  text: string;
  usedAi: boolean;
  generatedAt: string;
  /** 「今日建議」或「明日操作建議」「下個交易日操作建議」（依產生當下的時段，見 tradingStance.ts） */
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

// 2026-10-05 使用者要求：14:30 後到隔天開盤前（含週末）改成「明日操作建議」，內容要寫明天整個交易時段（開盤＋盤中）的操作計畫，
// 不能只看開盤那一刻（使用者：「我不是指開盤就直接買，盤中也可以買」）。
function actionRoleNextOpen(stance: TradingStance): string {
  return `你是股票研究網站的「${stance.briefTitle}」撰稿人，讀者沒有金融背景、要30秒看完做決定。台股今天已收盤（或週末休市），下一次開盤是 ${stance.nextOpenLabel} 09:00。任務只有一個：用最新收盤後的資料，直接講「${stance.nextOpenLabel}」整個交易時段（開盤與盤中）可以買哪幾檔、怎麼操作。不可寫「今天可以買」「現在盤中」。每檔的操作計畫（開盤跳空不追價、盤中回到區間分批買、買進後出場價）由程式依評等寫好附在每檔後面，你不用寫價位；等回檔的股票是「${stance.nextOpenLabel}盤中回到區間可分批買」，不可寫「開盤沒有可直接買的」這種讓人以為那天都不能買的句子。`;
}

// 2026-10-05 結構性修正：名單（分組、每組上限、排序、去重、不建議追）全部由程式決定（actionPicks.ts），
// AI 只回 JSON 寫解說；畫面文字由 renderActionBrief 組出來，價位也由程式寫（AI 不寫價位，就不會抄錯）。
// 以前的門檻規則（不可放寬也不可加嚴、技術面沒訊號照樣列、0 檔才觀望…）改由程式保證，提示詞只留寫作規則。
const ACTION_RULE_LIST_FIXED = [
  "【名單由程式決定（硬性）】【建議名單】A組（建議買進）、B組（等回檔，現價不買）、【不建議追】都已由程式依本站綜合評等選好。你不可增減股票、不可把股票換組、不可另外推薦名單外的股票；只能為名單裡每一檔寫理由與風險，並給你自己的排序偏好與看法。",
  "- 籌碼面【不支持】、RSI超買、觸及布林通道上緣是『漲多警訊』，不可當買進理由；技術面沒訊號的照樣寫理由，誠實說技術面今天沒有夠強的訊號。",
  "- B組（等回檔）的理由要講為什麼現價不買（漲多警訊／急漲／高於區間），不可寫成現在可以買。",
  "- 不要在 JSON 任何欄位寫價位數字（買進區間、出場價、不追價由程式附在每檔後面）；理由與風險只用體檢表裡的數字（張數、%、倍數）。",
].join("\n");

function actionFormat(stance: TradingStance): string {
  const nextOpen = stance.briefMode === "next-open";
  return [
    "【輸出格式（硬性）】只能回傳一個 JSON 物件本身，不要 markdown code block、不要其他文字：",
    '{"market":"…","order":["代號",…],"picks":{"代號":{"reason":"…","risk":"…"}},"view":"…","confidence":"高|中|低","confidenceReason":"…","notChase":"…","watch":"…"}',
    nextOpen
      ? "- market：一句白話講最近一個交易日收盤後的氣氛與下個交易日要留意的方向（≤30字，不要堆指數數字；大盤概況沒有台股加權指數報價時，不可說台股漲跌或創新高）。"
      : "- market：一句白話講今天氣氛（≤30字，不要堆指數數字；大盤概況沒有台股加權指數當日報價時，不可說台股漲跌或創新高）。",
    "- order：A、B 兩組所有代號依你看好程度由高到低（只能用名單裡的代號）。",
    "- picks：名單裡每一檔都要有。reason＝2~3個最關鍵的數字（≤60字，術語第一次出現帶括號白話，例：三大法人（外資、投信、自營商）買超6,592張、本益比（股價是年獲利幾倍）11.74倍）；risk＝一句風險，只能根據體檢表裡的數字（評等理由有「短線波動風險」（急漲）時就寫這句：短線常回檔、宜分批）。",
    "- view：1~2句表達你自己的排序與把握（2026-10-05 使用者：AI 變太保守、不敢表達）：兩組合起來最看好哪一檔、其次哪一檔、各為什麼（一個關鍵數字），等回檔的寫觸發條件（回到區間或站穩壓力，不寫價位數字）。不可推翻評等的動作結論（等回檔不可講成現在可買）。名單 0 檔時給空字串。",
    "- confidence＋confidenceReason：把握程度與一句原因。",
    "- notChase：只針對【不建議追（程式已選定）】那一檔寫一句（≤40字）講它哪些面向沒跟上；程式寫沒有要點名的就給空字串。",
    "- watch：一句要注意的風險（不是利多），取材只能來自【近期重大消息】或體檢結果，參考資料沒提到的總經事件一律不可寫。",
    "措辭不可暗示「照建議買會贏大盤」；網站頁首已說明本站評等回測未顯示穩定超越大盤，內文不用重複。不要開場白、客套或免責聲明。",
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
  ACTION_RULE_LIST_FIXED,
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

export { PULLBACK_GROUP_TITLE, groupedPickLines, type ActionBriefPick } from "./actionPicks";

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
    // v10：14:30 後改「明日操作建議」（開盤＋盤中操作計畫）。
    // v11：2026-10-05 名單（分組上限、互斥）改由程式決定、AI 回 JSON 只寫解說，加 AI 看法行。
    `action-brief:v11:${taipeiDayKey()}:${stance.briefMode}`,
    ACTION_BRIEF_TTL_MS,
    async () => {
      const { text: grounding, picks: ratedPicks, indexSummary, notChase, gainersAvailable } = await buildActionGrounding();
      const sysPrompt = buildActionSystemPrompt(stance);
      // 主文 AI 與 AI 判斷層（每檔每天最多一次、快取）平行跑；判斷層失敗就沒有 AI 看法行，不影響名單。
      const [result, judgments] = await Promise.all([
        // Not on a blocking user-wait path (client-fetched, not SSR-blocking).
        // maxOutputTokens 給足：CJK token 多，被截斷的 JSON 解析不了會退回程式版。
        callAiProviders(sysPrompt, [{ role: "user", content: `參考資料：\n${stance.stanceLine}\n\n${grounding}` }], {
          timeoutMs: 25000,
          maxOutputTokens: 1600,
        }),
        getAiJudgments(
          ratedPicks.map((p) => p.rating),
          "today-brief"
        ).catch(() => new Map<string, AiJudgment>()),
      ]);
      const picks: ActionBriefPick[] = ratedPicks.map((p) => ({
        symbol: p.rating.symbol,
        name: p.rating.name,
        label: p.rating.rating.label,
        code: p.rating.rating.code,
        holdingLabel: p.rating.rating.holdingLabel,
        reason: p.rating.rating.reason,
        plan: buildPlan(p.rating.rating, stance),
        aiView: describeAiView(judgments.get(p.rating.symbol.toUpperCase()), p.rating.rating.code),
      }));
      const base = { title: stance.briefTitle, mode: stance.briefMode, picks };
      const ai = result.usedAi ? parseActionBriefJson(result.answer) : null;
      if (result.usedAi && !ai) console.warn("[action-brief] AI 回傳不是 JSON，改用程式版");
      const text = renderActionBrief({
        stance,
        marketLine: indexSummary.replace(/^大盤：/, ""),
        buy: picks.filter((p) => p.code === "buy"),
        pullback: picks.filter((p) => p.code === "buy-on-pullback"),
        notChase,
        gainersAvailable,
        ai,
        failureNote: result.usedAi ? "AI 回傳格式錯誤" : result.failureReason ?? "未知原因",
      });
      // AI 寫的理由裡若有價位數字，跟程式價位比對（見 numberGuard.ts）。
      const guarded = guardAnswerNumbers(text, grounding);
      if (guarded.fixes.length > 0) console.warn("[action-brief] 更正 AI 抄錯的價位：", JSON.stringify(guarded.fixes));
      return { ...base, text: guarded.text, usedAi: !!ai, generatedAt: new Date().toISOString() };
    },
    // 過期先回舊建議、背景重算（寬限期見 swrPolicy.ts），訪客不用現場等 AI。
    { forceRefresh, staleWhileRevalidateMs: AI_SWR_MS }
  );
}
