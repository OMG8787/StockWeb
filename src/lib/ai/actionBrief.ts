import { MARGIN_SIGNAL_TITLE } from "./marginSignalData";
import { getQuote } from "@/lib/data";
import { formatLiveQuote } from "./livePrice";
import { confidenceText } from "./siteRating";
import { peekCached, writeCached } from "@/lib/data/cache";
import { cachedWithDegradedPredicate } from "@/lib/data/degradedCache";
import { taipeiDayKey } from "@/lib/pollingSchedule";
import { slotCached } from "./slotCache";
import { actionBriefSlot, nextActionBriefSlotTime } from "./aiSchedule";
import type { StockRatingResult } from "./stockRating";
import { premiumFellBack } from "./gemini";
import { callAiProviders } from "@/lib/ai/provider";
import { buildActionGrounding } from "./actionGrounding";
import { frozenListEpochKey, LAST_LIST_TTL_MS } from "./actionStability";
import {
  buildPlan,
  mergeAiExplanation,
  parseActionBriefJson,
  renderActionBrief,
  type ActionAiLayer,
  type ActionBriefPick,
  type NotChasePick,
} from "./actionPicks";
import { getAiJudgments } from "./aiJudge";
import type { AiJudgment } from "./learning/aiAdjust";
import { guardAnswerNumbers } from "./numberGuard";
import { modelInfo, type ModelInfo } from "./modelName";
import { getTradingStance, type BriefMode, type TradingStance } from "./tradingStance";
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
  /** 產生白話解說的模型（AI 失敗走程式版時沒有） */
  model?: ModelInfo;
  /** 名單（程式依本站綜合評等決定，AI 問答全市場推薦也讀這份） */
  picks: ActionBriefPick[];
  /** 要用較強模型、但額度用完或暫時無法使用而改用其他模型（卡片標示用） */
  fellBackToLite?: boolean;
  /** 「先不要買／不建議追」那一檔的代號（前端輪詢現價用；沒有就 undefined） */
  notChaseSymbol?: string;
  /** 名單與價位（程式即時層）的計算時間；generatedAt 是 AI 解說撰寫時間（沒有 AI 時同 listAt） */
  listAt?: string;
}

// 2026-09-20：拉長回 30 分鐘——這是一段給人「一天看幾次」的摘要性建議文字，
// 不需要分鐘級新鮮度；背後又疊了好幾個本來就很貴的資料源（技術訊號共振股要
// 抓K線、還要呼叫一次外部AI），5分鐘的 warm-cache 排程若每次都重算整段（含
// AI呼叫），是 Vercel 用量吃緊後盤點出來的浪費源頭之一，理由同
// lib/data/index.ts 的 FUNDAMENTALS_TTL_MS 說明。
// 2026-10-04：使用者要求縮短為 10 分鐘。
// 2026-10-05：改成只在 aiSchedule.ts 的關鍵時點重寫（較強模型每日額度有限），不再用滾動 TTL。

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
  return `你是股票研究網站的「${stance.briefTitle}」撰稿人，讀者沒有金融背景、要30秒看完做決定。台股今天已收盤（或週末休市），下一次開盤是 ${stance.nextOpenLabel} 09:00。任務只有一個：用最新收盤後的資料，直接講「${stance.nextOpenLabel}」整個交易時段（開盤與盤中）可以買哪幾檔、怎麼操作。不可寫「今天可以買」「現在盤中」。名單裡每一檔都是「建議買進」＝${stance.nextOpenLabel}開盤或盤中可買（分批）；操作計畫（拉回加碼參考價、買進後出場價）由程式依評等寫好附在每檔後面，你不用寫價位。不可寫「現價不買」「等回到區間再買」「先觀望」這類跟建議買進矛盾的話（2026-10-05 使用者：給了區間、到了又說不建議，優柔寡斷錯失機會）。`;
}

// 2026-10-05 結構性修正：名單（分組、每組上限、排序、去重、不建議追）全部由程式決定（actionPicks.ts），
// AI 只回 JSON 寫解說；畫面文字由 renderActionBrief 組出來，價位也由程式寫（AI 不寫價位，就不會抄錯）。
// 以前的門檻規則（不可放寬也不可加嚴、技術面沒訊號照樣列、0 檔才觀望…）改由程式保證，提示詞只留寫作規則。
const ACTION_RULE_LIST_FIXED = [
  "【名單由程式決定（硬性）】【建議買進名單】與【先不要買／不建議追】都已由程式依本站綜合評等選好。你不可增減股票、不可另外推薦名單外的股票；只能為名單裡每一檔寫理由與風險，並給你自己的排序偏好與看法。",
  "- 名單裡每一檔結論都是『建議買進』（現價可分批買）：理由要果斷說明為什麼可以買，不可寫「現價不買」「等回檔再買」「先觀望」。評等理由有「短線風險」（近幾日急漲、漲多警訊、高於支撐區）時寫在 risk：宜分批、不要一次買滿；有「大盤偏弱提示」時 risk 可提宜降低部位。",
  "- 籌碼面【不支持】、RSI超買、觸及布林通道上緣是『漲多警訊』，不可當買進理由；技術面沒訊號的照樣寫理由，誠實說技術面今天沒有夠強的訊號。",
  "- 不要在 JSON 任何欄位寫價位數字（加碼參考價、出場價由程式附在每檔後面）；理由與風險只用體檢表裡的數字（張數、%、倍數）。",
].join("\n");

function actionFormat(stance: TradingStance): string {
  const nextOpen = stance.briefMode === "next-open";
  return [
    "【輸出格式（硬性）】只能回傳一個 JSON 物件本身，不要 markdown code block、不要其他文字：",
    '{"market":"…","picks":{"代號":{"reason":"…","risk":"…"}},"view":"…","notChase":"…","watch":"…"}',
    nextOpen
      ? "- market：一句白話講最近一個交易日收盤後的氣氛與下個交易日要留意的方向（≤30字，不要堆指數數字；大盤概況沒有台股加權指數報價時，不可說台股漲跌或創新高）。"
      : "- market：一句白話講今天氣氛（≤30字，不要堆指數數字；大盤概況沒有台股加權指數當日報價時，不可說台股漲跌或創新高）。",
    "- picks：名單裡每一檔都要有。reason＝2~3個最關鍵的數字（≤60字，術語第一次出現帶括號白話，例：三大法人（外資、投信、自營商）買超6,592張、本益比（股價是年獲利幾倍）11.74倍）；risk＝一句風險，只能根據體檢表裡的數字（評等理由有「短線風險」時就寫這句：短線常回檔、宜分批）。",
    "- view：1~2句表達你自己的排序與把握（2026-10-05 使用者：AI 變太保守、不敢表達）：最看好哪一檔、其次哪一檔、各為什麼（一個關鍵數字），語氣果斷；名單順序與每檔「本站把握程度」由程式決定，不要自己另寫把握程度。名單 0 檔時給空字串。",
    "- notChase：只針對【先不要買／不建議追（程式已選定）】那一檔寫一句（≤40字）講它哪些面向沒跟上；程式寫沒有要點名的就給空字串。",
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

// 候選股參考資料有「${MARGIN_SIGNAL_TITLE}」那一行（程式算好、只有非中性才附）時的講法；不計分、不改面向數。
const ACTION_RULE_MARGIN_SIGNAL_SUFFIX = `候選股有「${MARGIN_SIGNAL_TITLE}」行時，點到那一檔就用一句講出訊號名稱、白話意義與依據數字（單日數字、不是趨勢，不可改成相反方向），但它不計入面向支持數、也不單獨決定買不買；沒有那一行就不要自己從融資融券數字編組合判讀。`;

// 「持股結構面」在今日建議裡的專屬規則（措辭共通規則在 RULE_HOLDING_STRUCTURE_WORDING）。
const ACTION_RULE_HOLDING_STRUCTURE = `籌碼面＝三大法人今天買賣超幾張（流量）；${HOLDING_STRUCTURE_FACET_NAME}＝大戶／外資持股比例、融資使用率、融券使用率跟前期比的變化（存量），兩者不要混為一談。引用時帶實際數字，不寫「持股結構不錯」這種空話；標【無資料】就寫查不到，不可編數字。融資使用率偏高或單日急升是散戶槓桿升溫的追高風險，不可講成利多。融券使用率只列資訊不計分：${RULE_SHORT_UTILIZATION_MEANING}${ACTION_RULE_MARGIN_SIGNAL_SUFFIX}`;

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

export { NOT_CHASE_TITLE, groupedPickLines, type ActionBriefPick } from "./actionPicks";

/** AI 解說層快取前綴：帶台北日期＋時段——不跨日沿用、今日建議→明日操作建議時換一份（slotCached 的 latest 也在這個前綴下）。 */
export function actionAiLayerPrefix(day: string, mode: BriefMode): string {
  // v3：2026-10-07 KD 改券商遞迴算法（舊 KD 算的解說不可沿用）。
  return `action-brief-ai:v3:${day}:${mode}`;
}

/** 程式即時層（名單、結論、價位、操作計畫）：跟 stockRating 同樣 10 分鐘，不需要 AI、不吃配額。 */
export const ACTION_LIST_TTL_MS = 10 * 60_000;
/** 上游整份抓不到（degradedReasons 非空）時只快取這麼久，讓它盡快自我修復（不要把缺資料的名單放 10 分鐘）。 */
export const ACTION_LIST_DEGRADED_TTL_MS = 60_000;

interface ActionListLayer {
  grounding: string;
  picks: ActionBriefPick[];
  ratings: StockRatingResult[];
  indexSummary: string;
  notChase: NotChasePick | null;
  gainersAvailable: boolean;
  marketNote: string | null;
  listAt: string;
  /** 輸入不完整的原因（空陣列＝完整）；非空時只快取 ACTION_LIST_DEGRADED_TTL_MS */
  degradedReasons: string[];
}

/** 「資料已定」時段內上一份名單的存檔（見 actionStability.ts）：只存完整輸入算出來的名單評等。 */
interface LastActionList {
  at: string;
  picks: StockRatingResult[];
}

/** 上一份名單存檔的 key：帶「資料已定」時段代號（週末、夜間到隔天開盤前同一份）。 */
export function lastActionListKey(epoch: string): string {
  return `action-list-last:v1:${epoch}`;
}

/** AI 解說層快取物件（slotCached 需要 usedAi）。 */
interface StoredAiLayer extends ActionAiLayer {
  usedAi: boolean;
  generatedAt: string;
  model?: ModelInfo;
  fellBackToLite?: boolean;
}

async function computeActionList(stance: TradingStance): Promise<ActionListLayer> {
  // 資料已定的時段（夜間到隔天開盤前、週末）：同一時段上一份名單的股票，只有被重新評等為不建議買進才換掉，
  // 上游抓失敗不會讓整份名單重排（見 actionStability.ts；盤中與 14:30～22:00 資料在變，不套用）。
  const epoch = frozenListEpochKey(new Date());
  const last = epoch ? await peekCached<LastActionList>(lastActionListKey(epoch)).catch(() => undefined) : undefined;
  const { text: grounding, picks: ratedPicks, indexSummary, notChase, gainersAvailable, marketNote, degradedReasons } =
    await buildActionGrounding({ previousPicks: last?.picks });
  if (degradedReasons.length > 0) console.warn("[action-list] 輸入不完整：", degradedReasons.join("、"));
  const picks: ActionBriefPick[] = ratedPicks.map((p) => ({
    symbol: p.rating.symbol,
    name: p.rating.name,
    label: p.rating.rating.label,
    code: p.rating.rating.code,
    holdingLabel: p.rating.rating.holdingLabel,
    reason: p.rating.rating.reason,
    plan: buildPlan(p.rating.rating, stance),
    confidence: confidenceText(p.rating.rating) || undefined,
    riskNote: p.rating.rating.riskNote ?? undefined,
  }));
  const ratings = ratedPicks.map((p) => p.rating);
  // 只有輸入完整的這次才存檔當「上一份名單」（不完整的名單不能當之後的基準）。
  if (epoch && degradedReasons.length === 0) {
    await writeCached<LastActionList>(lastActionListKey(epoch), { at: new Date().toISOString(), picks: ratings }, LAST_LIST_TTL_MS).catch(() => {});
  }
  return { grounding, picks, ratings, indexSummary, notChase, gainersAvailable, marketNote, listAt: new Date().toISOString(), degradedReasons };
}

async function getActionList(stance: TradingStance, forceRefresh: boolean): Promise<ActionListLayer> {
  // v2（2026-10-06）：新增 degradedReasons 與凍結時段穩定名單；輸入不完整只快取 1 分鐘。
  // v3：2026-10-06 名單依本站把握程度排序、每檔附程式把握程度（confidence）。
  // v4：2026-10-07 每檔附程式風險原句（riskNote，四入口比較）。
  // v5：2026-10-07 KD 改券商遞迴算法（舊 KD 算的名單不可沿用）。
  const key = `action-list:v5:${taipeiDayKey()}:${stance.briefMode}`;
  const isDegraded = (l: ActionListLayer) => (l.degradedReasons?.length ?? 0) > 0;
  if (forceRefresh) {
    const fresh = await computeActionList(stance);
    await writeCached(key, fresh, isDegraded(fresh) ? ACTION_LIST_DEGRADED_TTL_MS : ACTION_LIST_TTL_MS);
    return fresh;
  }
  return cachedWithDegradedPredicate(key, ACTION_LIST_TTL_MS, ACTION_LIST_DEGRADED_TTL_MS, isDegraded, () => computeActionList(stance));
}

/**
 * 今日建議＝兩層合併（2026-10-06 整合稽核：只用 slotCached 時名單與價位可能比個股評等舊數小時、甚至跨日）：
 * ①名單、結論、價位、操作計畫＝程式即時（getActionList，跟 stockRating 同一份 10 分鐘評等）；
 * ②AI 解說（理由、看法、排序）＝只在 aiSchedule.ts 的時點用較強模型重寫（slotCached），key 帶台北日期＋時段，
 *   不跨日、時段切換（今日→明日操作）換一份；合併規則見 actionPicks.ts mergeAiExplanation。
 */
export async function getActionBrief(forceRefresh = false): Promise<ActionBrief> {
  const stance = getTradingStance();
  const list = await getActionList(stance, forceRefresh);
  // 版本史：v2～v13 見 git log；v14 改時點重寫；ai:v1（2026-10-06）只存 AI 解說，名單改程式即時。
  const layer = await slotCached<StoredAiLayer>(
    actionAiLayerPrefix(taipeiDayKey(), stance.briefMode),
    actionBriefSlot(),
    async () => {
      const sysPrompt = buildActionSystemPrompt(stance);
      // AI 判斷層照樣在時點跑、只寫進評等紀錄（冠軍／挑戰者證明前不顯示給使用者，2026-10-06 使用者：「那到底要以哪個為主」）。
      const [result] = await Promise.all([
        callAiProviders(sysPrompt, [{ role: "user", content: `參考資料：
${stance.stanceLine}

${list.grounding}` }], {
          timeoutMs: 40000,
          totalBudgetMs: 40000, // 思考模型可用 65%≈26 秒（原 25 秒只剩 16 秒，實測 3-flash-preview 小題就要 10 秒，常逾時退回 lite）；名單另抓＋這段＜maxDuration 60
          maxOutputTokens: 1600,
          // 每天少量、價值高：用非 lite 思考模型（有每日配額，用完自動退回 lite，見 gemini.ts）。
          geminiTier: "premium",
          geminiPurpose: "action",
        }),
        getAiJudgments(list.ratings, "today-brief").catch(() => new Map<string, AiJudgment>()),
      ]);
      const ai = result.usedAi ? parseActionBriefJson(result.answer) : null;
      if (result.usedAi && !ai) console.warn("[action-brief] AI 回傳不是 JSON，改用程式版");
      return {
        ai,
        labels: Object.fromEntries(list.picks.map((p) => [p.symbol.toUpperCase(), p.label])),
        notChaseSymbol: list.notChase?.symbol ?? null,
        usedAi: !!ai,
        generatedAt: new Date().toISOString(),
        ...(ai ? { model: modelInfo(result.model), fellBackToLite: premiumFellBack(result.model) } : {}),
      };
    },
    { forceRefresh }
  ).catch(() => null);

  // 每檔即時現價（2026-10-07 使用者：四入口出現的每一檔都要顯示當前現價）：不進快取層、每次回應用 getQuote 重算
  // （跟 AI 問答同一個報價來源與格式 livePrice.ts）；前端盤中再每 30 秒輪詢更新。
  const priceOf = new Map(list.ratings.map((r) => [r.symbol.toUpperCase(), r.price]));
  const [pickQuotes, ncQuote] = await Promise.all([
    Promise.all(list.picks.map((p) => getQuote(p.symbol, "TW").catch(() => null))),
    list.notChase ? getQuote(list.notChase.symbol, "TW").catch(() => null) : Promise.resolve(null),
  ]);
  const livePicks = list.picks.map((p, i) => ({
    ...p,
    ratingPrice: priceOf.get(p.symbol.toUpperCase()),
    ...(pickQuotes[i] ? { livePrice: formatLiveQuote(pickQuotes[i]!, priceOf.get(p.symbol.toUpperCase())) } : {}),
  }));
  const liveNotChase = list.notChase && ncQuote ? { ...list.notChase, livePrice: formatLiveQuote(ncQuote, priceOf.get(list.notChase.symbol.toUpperCase())) } : list.notChase;
  const merged = mergeAiExplanation(livePicks, layer, list.notChase?.symbol ?? null, nextActionBriefSlotTime());
  const text = renderActionBrief({
    stance,
    marketLine: list.indexSummary.replace(/^大盤：/, ""),
    buy: merged.picks.filter((p) => p.code !== "avoid"),
    notChase: liveNotChase,
    marketNote: list.marketNote,
    gainersAvailable: list.gainersAvailable,
    ai: merged.ai,
    failureNote: "模型暫時無法使用，下次更新時點會再試",
  });
  // AI 寫的理由裡若有價位數字，跟程式價位比對（見 numberGuard.ts）。
  const guarded = guardAnswerNumbers(text, list.grounding);
  if (guarded.fixes.length > 0) console.warn("[action-brief] 更正 AI 抄錯的價位：", JSON.stringify(guarded.fixes));
  const usedAi = !!merged.ai;
  return {
    title: stance.briefTitle,
    mode: stance.briefMode,
    picks: livePicks,
    ...(list.notChase ? { notChaseSymbol: list.notChase.symbol } : {}),
    text: guarded.text,
    usedAi,
    listAt: list.listAt,
    generatedAt: usedAi && layer ? layer.generatedAt : list.listAt,
    ...(usedAi && layer?.model ? { model: layer.model, fellBackToLite: layer.fellBackToLite } : {}),
  };
}
