import { cached } from "@/lib/data/cache";
import {
  describeTaifexNightFutures,
  getChips,
  getChipsRanking,
  getEarnings,
  getFundamentals,
  getIndices,
  getMaterialAnnouncements,
  getMultiSignalStocks,
  getTaifexNightFutures,
  getValueScreen,
  searchStocks,
  type ChipsRankingItem,
  type MomentumItem,
} from "@/lib/data";
import type { Chips, Earnings, Fundamentals, MaterialAnnouncement } from "@/lib/data/types";
import type { Signal } from "@/lib/signals";
import { getNewsFeed, type NewsFeed } from "@/lib/ai/newsfeed";
import { formatSharesWithLots } from "@/lib/format";
import { callAiProviders } from "@/lib/ai/provider";

export interface ActionBrief {
  text: string;
  usedAi: boolean;
  generatedAt: string;
}

// 2026-09-20：拉長回 30 分鐘——這是一段給人「一天看幾次」的摘要性建議文字，
// 不需要分鐘級新鮮度；背後又疊了好幾個本來就很貴的資料源（技術訊號共振股要
// 抓K線、還要呼叫一次外部AI），5分鐘的 warm-cache 排程若每次都重算整段（含
// AI呼叫），是 Vercel 用量吃緊後盤點出來的浪費源頭之一，理由同
// lib/data/index.ts 的 FUNDAMENTALS_TTL_MS 說明。
const ACTION_BRIEF_TTL_MS = 30 * 60_000;

const MOMENTUM_LIMIT = 8;
// 漲幅榜刻意也被納入「完整體檢」的候選名單，不是只拿來當背景資料：使用者明確要求
// 「不是漲停的就推薦要買」，要示範這個判斷邏輯，AI 手上就必須有「今天漲最多的那幾檔
// 在其他面向到底有沒有跟上」的完整資料，才有辦法具體講出「這檔漲 9% 但法人在賣、
// 本益比 60 倍，不建議追」這種反例。只給它一份沒有體檢資料的漲幅榜，它只能含糊帶過。
const GAINER_CANDIDATE_LIMIT = 6;
const CHIP_CANDIDATE_LIMIT = 6;
const TRUST_CANDIDATE_LIMIT = 4;
// 體檢表的總長度上限。每一檔的四個面向全部來自「整個市場一次抓回來再查表」的既有快取
// （fundamentals:TW:all、chips:TW:institutional、earnings:TW:revenue、
// announcements:TW:all），所以多一檔幾乎不花額外的網路成本，真正的限制是 prompt 長度
// 跟 AI 一次能認真讀完的資訊量。
const CANDIDATE_LIMIT = 16;
// 流動性下限，跟 getValueScreen 的 VALUE_SCREEN_MIN_TURNOVER_TWD 同一個理由：漲幅榜
// 前幾名常常被「一天只成交幾萬元的殭屍股」佔滿，那種股票就算列出來也買不到、賣不掉，
// 拿來當建議或反例都沒有意義。
const CANDIDATE_MIN_TURNOVER_TWD = 30_000_000;
// 美股只補最前面幾檔的基本面/財報：美股沒有全市場批次端點，每一檔都是獨立一次 Yahoo
// 請求，補太多會把整頁的延遲拖進 AI 呼叫的時間預算裡。美股也沒有公開的法人籌碼資料源，
// 本來就湊不齊四個面向，所以這一頁的買進建議本質上以台股為主。
const US_ENRICH_LIMIT = 4;

// 進入「建議買進」候選的客觀門檻。prompt 裡也會重述一次，但真正決定 qualified 名單、
// 以及 AI 掛掉時 fallback 怎麼寫的是這兩個常數——不讓 AI 自己心證判斷夠不夠格。
const QUALIFY_MIN_SUPPORT = 2;
const QUALIFY_MAX_AGAINST = 1;

// 估值的粗略分界線。這是本站自己設的門檻、不是什麼權威標準，所以 prompt 裡也要求 AI
// 引用實際數字（「本益比 12 倍」）而不是只轉述「便宜」這個結論。
const PE_CHEAP = 20;
const PE_EXPENSIVE = 40;
const YIELD_GOOD = 4;

// tone 是 "up" 但實際上是「漲多了」的警訊，不是買進理由——PROGRESS.md 記過一個真實
// 教訓：同一筆「RSI 86 超買」資料，今日建議頁講成警訊、聊天追問裡卻拿來當正面理由。
// 這裡直接在資料層把它們跟真正的多方訊號分開，AI 就不會把「超買」算進支持面向裡。
const OVERHEAT_PATTERNS = ["超買", "布林通道上緣"];

type Verdict = "支持" | "中性" | "不支持" | "無資料";

interface Facet {
  name: string;
  verdict: Verdict;
  detail: string;
}

interface Candidate {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  /** 這檔為什麼會進到體檢名單（技術訊號共振／漲幅榜第N名／外資買超第N名…） */
  sources: string[];
  signals: Signal[];
  chips: Chips | null;
  fundamentals: Fundamentals | null;
  earnings: Earnings | null;
  announcements: MaterialAnnouncement[];
  headlines: string[];
}

interface ScoredCandidate extends Candidate {
  facets: Facet[];
  supportCount: number;
  againstCount: number;
  newsFacet: Facet;
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}%`;
}

function technicalFacet(c: Candidate): Facet {
  if (c.signals.length === 0) {
    // 「無資料」在這裡的意思跟籌碼面的「查無資料」不一樣：K線抓得到、指標也算得出來，
    // 只是今天沒有2個以上訊號同時成立而已。實測 AI 會把這一格直接寫成「技術面無資料」，
    // 讀者會誤以為是系統抓不到資料，所以 detail 要把「不是抓不到」講在明處。
    return {
      name: "技術面",
      verdict: "無資料",
      detail: `無可用的技術面佐證：今日${pct(c.changePercent)}，但沒有2個以上技術訊號同時成立，所以未進入技術訊號共振清單（注意：這是「今天沒有出現夠強的技術訊號」，不是「技術資料抓不到」，轉述時不要講成資料缺失）`,
    };
  }
  const overheat = c.signals.filter((s) => s.tone === "up" && OVERHEAT_PATTERNS.some((p) => s.label.includes(p)));
  const bull = c.signals.filter((s) => s.tone === "up" && !overheat.includes(s));
  const bear = c.signals.filter((s) => s.tone === "down");
  const parts = [
    bull.length > 0 ? `多方訊號：${bull.map((s) => s.label).join("、")}` : "",
    overheat.length > 0 ? `漲多警訊（不算正面理由）：${overheat.map((s) => s.label).join("、")}` : "",
    bear.length > 0 ? `空方訊號：${bear.map((s) => s.label).join("、")}` : "",
  ].filter(Boolean);
  const verdict: Verdict =
    bull.length >= 2 && bear.length === 0 ? "支持" : bear.length > bull.length ? "不支持" : "中性";
  return { name: "技術面", verdict, detail: parts.join("；") };
}

function chipsFacet(c: Candidate): Facet {
  const inst = c.chips?.institutionalNetShares;
  if (inst == null) {
    return { name: "籌碼面", verdict: "無資料", detail: "查無今日三大法人買賣超資料" };
  }
  // 0 要特別描述成「買賣超持平」：formatSharesWithLots(0) 會產生「+0股（約+0張）」，
  // 實測 AI 讀到之後寫成「投信買超0張」——「買超 0 張」對新手讀者是自相矛盾的說法
  // （到底有沒有買？），這一層先把語意講清楚，AI 才不用自己猜。
  const side = (label: string, v: number | null | undefined) =>
    v == null ? "" : v === 0 ? `${label}今日買賣超持平（0張）` : `${label}${formatSharesWithLots(v)}`;
  const extra = [
    side("外資", c.chips?.foreignNetShares),
    side("投信", c.chips?.trustNetShares),
    c.chips?.marginBalanceChange != null
      ? `融資餘額變化${c.chips.marginBalanceChange >= 0 ? "+" : ""}${c.chips.marginBalanceChange.toLocaleString("en-US")}張`
      : "",
  ].filter(Boolean);
  const detail = `三大法人合計${formatSharesWithLots(inst)}${extra.length > 0 ? `（${extra.join("、")}）` : ""}`;
  const verdict: Verdict = inst > 0 ? "支持" : inst < 0 ? "不支持" : "中性";
  return { name: "籌碼面", verdict, detail };
}

function valuationFacet(c: Candidate): Facet {
  const pe = c.fundamentals?.peRatio;
  const pb = c.fundamentals?.pbRatio;
  const dy = c.fundamentals?.dividendYield;
  if (pe == null && pb == null && dy == null) {
    return { name: "基本面（估值）", verdict: "無資料", detail: "查無本益比／股價淨值比／殖利率" };
  }
  const detail = [
    pe != null && pe > 0 ? `本益比${pe}倍` : pe != null ? "本益比無意義（公司虧損或無獲利資料）" : "",
    pb != null && pb > 0 ? `股價淨值比${pb}倍` : "",
    dy != null && dy > 0 ? `殖利率${dy}%` : "",
  ]
    .filter(Boolean)
    .join("、");
  let verdict: Verdict = "中性";
  if (pe != null && pe > PE_EXPENSIVE) verdict = "不支持";
  else if ((pe != null && pe > 0 && pe <= PE_CHEAP) || (dy != null && dy >= YIELD_GOOD)) verdict = "支持";
  return { name: "基本面（估值）", verdict, detail };
}

function earningsFacet(c: Candidate): Facet {
  const yoy = c.earnings?.monthlyRevenueYoyPercent;
  const eps = c.earnings?.quarterlyEps;
  if (yoy == null && eps == null) {
    return { name: "財報面", verdict: "無資料", detail: "查無最新月營收年增率／每股盈餘" };
  }
  const detail = [
    yoy != null ? `${c.earnings?.monthlyRevenuePeriod ?? "最新月"}營收年增率${pct(yoy)}` : "",
    eps != null ? `${c.earnings?.quarterlyEpsPeriod ?? "最新一季"}每股盈餘${eps}元` : "",
  ]
    .filter(Boolean)
    .join("、");
  let verdict: Verdict = "中性";
  if ((yoy != null && yoy < 0) || (eps != null && eps < 0)) verdict = "不支持";
  else if (yoy != null && yoy > 0) verdict = "支持";
  return { name: "財報面", verdict, detail };
}

/**
 * 消息面刻意不判斷方向，verdict 永遠不會是「支持」。
 *
 * 一則標題到底是利多還是利空，程式沒辦法用規則判斷（「XX 遭調查」跟「XX 獲大單」對
 * 程式而言都只是「有消息」），硬給一個 verdict 等於編造判斷。所以這個面向只負責把
 * 真實標題原封不動端上來由 AI 自己讀，也因此不計入「面向支持數」——支持數只由技術面／
 * 籌碼面／基本面／財報面這四個有客觀規則可循的面向組成。
 */
function newsFacet(c: Candidate): Facet {
  const lines = [
    ...c.announcements.slice(0, 2).map((a) => `${a.date} 重大訊息公告：${a.subject}`),
    ...c.headlines.slice(0, 2).map((h) => `新聞標題：${h}`),
  ];
  if (lines.length === 0) {
    return { name: "消息面", verdict: "無資料", detail: "今日沒有查到跟這檔直接相關的公告或新聞" };
  }
  return { name: "消息面", verdict: "中性", detail: lines.join("；") };
}

function score(c: Candidate): ScoredCandidate {
  const facets = [technicalFacet(c), chipsFacet(c), valuationFacet(c), earningsFacet(c)];
  return {
    ...c,
    facets,
    supportCount: facets.filter((f) => f.verdict === "支持").length,
    againstCount: facets.filter((f) => f.verdict === "不支持").length,
    newsFacet: newsFacet(c),
  };
}

function describeCandidate(c: ScoredCandidate): string {
  const head = `● ${c.name}(${c.symbol})　現價 ${c.price}　今日 ${pct(c.changePercent)}　入選原因：${c.sources.join("／")}`;
  const body = [...c.facets, c.newsFacet].map((f) => `　- ${f.name}【${f.verdict}】${f.detail}`);
  const tail = `　→ 面向支持數：${c.supportCount}/4（其中明確不支持 ${c.againstCount} 項）`;
  return [head, ...body, tail].join("\n");
}

/**
 * 把所有「今天可能值得談」的台股集中成一份多面向體檢表。
 *
 * 候選來源刻意混合四種完全不同的挑法（技術訊號共振、今日漲幅榜、法人買超榜、投信買超
 * 榜），是為了讓 AI 手上同時有「四個面向都到位的好標的」跟「只有單一面向亮眼、其他面向
 * 完全沒跟上的假訊號」兩種樣本可以對照。如果只餵技術訊號共振股，AI 看到的每一檔都長得
 * 差不多，就沒辦法真的做出「這檔可以、那檔只是漲多不要追」的區辨。
 */
async function buildCandidates(
  twMomentum: MomentumItem[],
  gainers: Array<{ symbol: string; name: string; price: number; changePercent: number }>,
  chipsRanking: { foreignBuy: ChipsRankingItem[]; institutionalBuy: ChipsRankingItem[]; trustBuy: ChipsRankingItem[] },
  newsFeed: NewsFeed
): Promise<ScoredCandidate[]> {
  const base = new Map<string, Candidate>();
  const add = (
    s: { symbol: string; name: string; price: number; changePercent: number },
    source: string,
    signals?: Signal[]
  ) => {
    const existing = base.get(s.symbol);
    if (existing) {
      existing.sources.push(source);
      if (signals && existing.signals.length === 0) existing.signals = signals;
      return;
    }
    if (base.size >= CANDIDATE_LIMIT) return;
    base.set(s.symbol, {
      symbol: s.symbol,
      name: s.name,
      price: s.price,
      changePercent: s.changePercent,
      sources: [source],
      signals: signals ?? [],
      chips: null,
      fundamentals: null,
      earnings: null,
      announcements: [],
      headlines: [],
    });
  };

  twMomentum.slice(0, MOMENTUM_LIMIT).forEach((m) => add(m, "技術訊號共振清單", m.signals));
  gainers.slice(0, GAINER_CANDIDATE_LIMIT).forEach((g, i) => add(g, `今日漲幅榜第${i + 1}名`));
  chipsRanking.foreignBuy.slice(0, CHIP_CANDIDATE_LIMIT).forEach((s, i) => add(s, `外資買超榜第${i + 1}名`));
  chipsRanking.institutionalBuy.slice(0, CHIP_CANDIDATE_LIMIT).forEach((s, i) => add(s, `三大法人買超榜第${i + 1}名`));
  chipsRanking.trustBuy.slice(0, TRUST_CANDIDATE_LIMIT).forEach((s, i) => add(s, `投信買超榜第${i + 1}名`));

  // 真實新聞標題（排除 kind === "data"：那些是本站自己算出來的技術訊號卡片，不是外部
  // 新聞，拿來當「消息面佐證」等於把技術面重複計算兩次）。
  const realHeadlines = [...newsFeed.pinned, ...newsFeed.items].filter((n) => n.kind === "news").map((n) => n.title);

  const candidates = [...base.values()];
  await Promise.all(
    candidates.map(async (c) => {
      const [chips, fundamentals, earnings, announcements] = await Promise.all([
        getChips(c.symbol, "TW").catch(() => null),
        getFundamentals(c.symbol, "TW").catch(() => null),
        getEarnings(c.symbol, "TW").catch(() => null),
        getMaterialAnnouncements(c.symbol, "TW").catch(() => [] as MaterialAnnouncement[]),
      ]);
      c.chips = chips;
      c.fundamentals = fundamentals;
      c.earnings = earnings;
      c.announcements = announcements;
      c.headlines = realHeadlines.filter((t) => t.includes(c.name) || t.includes(c.symbol));
    })
  );

  return candidates
    .map(score)
    .sort(
      (a, b) => b.supportCount - a.supportCount || a.againstCount - b.againstCount || b.changePercent - a.changePercent
    );
}

function listUsMomentum(
  items: Array<{ name: string; symbol: string; changePercent: number; signals: Signal[] }>,
  extras: Map<string, { fundamentals: Fundamentals | null; earnings: Earnings | null }>
): string {
  return items
    .map((i) => {
      const e = extras.get(i.symbol);
      const pe = e?.fundamentals?.peRatio;
      const eps = e?.earnings?.quarterlyEps;
      const surprise = e?.earnings?.epsSurprisePercent;
      const extra = [
        pe != null && pe > 0 ? `本益比${pe}倍` : "",
        eps != null ? `最新一季每股盈餘${eps}美元` : "",
        surprise != null ? `財報較預期${pct(surprise)}` : "",
      ].filter(Boolean);
      return `${i.name}(${i.symbol})：${pct(i.changePercent)}，訊號：${i.signals.map((s) => s.label).join("、")}${
        extra.length > 0 ? `；${extra.join("、")}` : "；無可用的本益比／財報資料"
      }`;
    })
    .join("\n");
}

export interface ActionGrounding {
  text: string;
  /** 通過「面向支持數 ≥2 且明確不支持 ≤1」門檻的候選股；AI 掛掉時的 fallback 也要用。 */
  qualified: ScoredCandidate[];
  indexSummary: string;
}

/**
 * 抽成獨立的 exported 函式（而不是留在 getActionBrief 裡）是為了能單獨檢查餵給 AI 的
 * 原始資料。這一頁的正確性幾乎完全取決於 grounding 有沒有如實呈現各面向——「建議買進」
 * 這種話一旦建立在錯的或半套的資料上，比寫得含糊還糟——所以讓它可以被單獨叫起來檢查。
 */
export async function buildActionGrounding(): Promise<ActionGrounding> {
  const [indices, taifexFutures, twMomentum, usMomentum, newsFeed, chipsRanking, valueScreen, twAll] =
    await Promise.all([
      getIndices(),
      getTaifexNightFutures().catch(() => null),
      getMultiSignalStocks("TW"),
      getMultiSignalStocks("US"),
      getNewsFeed().catch((): NewsFeed => ({ pinned: [], items: [], generatedAt: new Date().toISOString() })),
      getChipsRanking("TW").catch(() => ({
        institutionalBuy: [],
        institutionalSell: [],
        foreignBuy: [],
        foreignSell: [],
        trustBuy: [],
      })),
      getValueScreen("TW").catch(() => ({ lowPe: [], highYield: [], lowPb: [], decliners: [] })),
      searchStocks({ market: "TW", sortBy: "changePercent", sortDir: "desc" }).catch(() => []),
    ]);

  const liquidGainers = twAll.filter((i) => i.turnover >= CANDIDATE_MIN_TURNOVER_TWD && i.changePercent > 0);

  const usTargets = usMomentum.slice(0, US_ENRICH_LIMIT);
  const usExtras = new Map<string, { fundamentals: Fundamentals | null; earnings: Earnings | null }>();
  const [candidates] = await Promise.all([
    buildCandidates(twMomentum, liquidGainers, chipsRanking, newsFeed),
    Promise.all(
      usTargets.map(async (s) => {
        const [fundamentals, earnings] = await Promise.all([
          getFundamentals(s.symbol, "US").catch(() => null),
          getEarnings(s.symbol, "US").catch(() => null),
        ]);
        usExtras.set(s.symbol, { fundamentals, earnings });
      })
    ),
  ]);

  const qualified = candidates.filter(
    (c) => c.supportCount >= QUALIFY_MIN_SUPPORT && c.againstCount <= QUALIFY_MAX_AGAINST
  );

  const indexSummary =
    indices.length > 0
      ? `大盤：${indices.map((i) => `${i.name} ${i.change >= 0 ? "+" : ""}${i.changePercent}%`).join("、")}。`
      : "大盤指數目前無法取得。";

  const text = [
    "【大盤概況（台股＋美股）】",
    indices.length > 0
      ? indices.map((i) => `${i.name}：${i.price}（${i.change >= 0 ? "+" : ""}${i.changePercent}%）`).join("\n")
      : "（大盤指數目前無法取得）",
    describeTaifexNightFutures(taifexFutures),
    "",
    "【今日台股候選股「多面向體檢表」——這是你做買進判斷的主要依據】",
    "候選來源刻意混合四種挑法：技術訊號共振清單、今日漲幅榜、三大法人買超榜、投信買超榜，所以這份名單裡同時有「多面向都到位的標的」跟「只有單一面向亮眼、其他面向沒跟上的假訊號」，請自己分辨，不要因為某檔出現在名單上就當成推薦。",
    `「面向支持數」是本站用客觀規則算好的（技術面／籌碼面／基本面／財報面四項，各自標【支持】【中性】【不支持】【無資料】），直接引用即可，不要自己重算或改成別的數字。消息面刻意不判斷利多利空、也不計入支持數，只把真實標題端給你，方向要你自己讀標題判斷。本站設定的估值分界：本益比 ${PE_CHEAP} 倍以下算便宜、${PE_EXPENSIVE} 倍以上算貴、殖利率 ${YIELD_GOOD}% 以上算高。`,
    candidates.length > 0 ? candidates.map(describeCandidate).join("\n") : "（今日無候選股資料）",
    "",
    `【本站已先幫你篩過的結果】今日候選股中，面向支持數 ≥${QUALIFY_MIN_SUPPORT} 且明確不支持面向 ≤${QUALIFY_MAX_AGAINST} 的共 ${qualified.length} 檔：${
      qualified.length > 0 ? qualified.map((c) => `${c.name}(${c.symbol})`).join("、") : "無"
    }`,
    "",
    "【今日台股漲幅榜前10（純價格表現，已濾掉成交金額不足3000萬的冷門股）——漲最多不等於值得買，務必回體檢表對照其他面向】",
    liquidGainers.length > 0
      ? liquidGainers
          .slice(0, 10)
          .map((i, idx) => `${idx + 1}. ${i.name}(${i.symbol})：${pct(i.changePercent)}，現價${i.price}`)
          .join("\n")
      : "（今日無上漲且成交金額達標的股票）",
    "",
    "【全市場低本益比排行（估值參考，已濾掉冷門股）】",
    valueScreen.lowPe.length > 0
      ? valueScreen.lowPe
          .slice(0, 6)
          .map((i) => `${i.name}(${i.symbol})：本益比${i.peRatio}倍，今日${pct(i.changePercent)}`)
          .join("\n")
      : "（無資料）",
    "【全市場高殖利率排行】",
    valueScreen.highYield.length > 0
      ? valueScreen.highYield
          .slice(0, 6)
          .map((i) => `${i.name}(${i.symbol})：殖利率${i.dividendYield}%，今日${pct(i.changePercent)}`)
          .join("\n")
      : "（無資料）",
    "",
    "【全市場三大法人賣超排行（股數已換算好張數，直接引用不要自己重算）】",
    chipsRanking.institutionalSell.length > 0
      ? chipsRanking.institutionalSell
          .slice(0, 5)
          .map((i) => `${i.name}(${i.symbol})：${formatSharesWithLots(i.netShares)}，今日${pct(i.changePercent)}`)
          .join("\n")
      : "（無資料）",
    "",
    "【美股技術訊號共振股（美股沒有公開的法人籌碼資料源，這是資料源限制不是抓取失敗，不要說成「查無」以外的理由）】",
    usMomentum.length > 0 ? listUsMomentum(usMomentum.slice(0, MOMENTUM_LIMIT), usExtras) : "（今日無）",
    "",
    "【近期重大消息（AI 已判斷為可能影響整體大盤等級）】",
    newsFeed.pinned.length > 0
      ? newsFeed.pinned.map((n) => `- ${n.title}${n.summary ? `：${n.summary}` : ""}`).join("\n")
      : "（目前沒有夠格的重大消息）",
  ].join("\n");

  return { text, qualified, indexSummary };
}

const ACTION_SYSTEM_PROMPT = [
  "你是一個股票研究網站的「今日建議」撰稿人，目標讀者是完全沒有股票/金融背景的一般人。這一頁的任務很明確：直接告訴讀者「今天有哪幾檔股票可以買、為什麼」。這不是市場回顧（那是另一頁「今日市場快報」的工作），也不是列一堆「值得留意」的模糊觀察。",
  "",
  "【最重要的一條：建議要直接，但門檻不能降】",
  "要用明確的建議語氣：「建議買進」「今天可以留意進場」「這檔我會買」，不要寫成「值得留意」「可以觀察一下」這種看完還是不知道到底要不要買的模糊說法。",
  "但是——一檔股票要被列進建議買進名單，必須通過多面向驗證，門檻如下（硬性規則，不可以自己放寬）：",
  `- 面向支持數 ≥${QUALIFY_MIN_SUPPORT}（技術面／籌碼面／基本面／財報面，參考資料裡已經幫你算好，直接引用），且明確【不支持】的面向不超過 ${QUALIFY_MAX_AGAINST} 項。參考資料的「本站已先幫你篩過的結果」會直接列出哪幾檔通過，你只能從那份名單裡挑。`,
  "- 籌碼面如果是【不支持】（法人在賣超），一律不可以列入建議買進，就算其他面向再漂亮也不行——大戶在出貨的時候叫一般人買進是不負責任的。",
  "- 絕對不可以只因為「今天漲停／今天漲最多／技術線很漂亮」就推薦。只有價格表現亮眼、其他面向沒跟上的股票屬於追高風險，不是買進標的。",
  "- 「RSI超買」「觸及布林通道上緣」這類訊號是『已經漲多了』的警訊，不是買進理由，不可以拿來當正面依據。",
  "通過門檻的通常只有 0-3 檔，列 1-3 檔就好，不要硬湊到 5 檔。",
  "",
  "【誠實比有內容更重要——這是本站最高原則】",
  "如果今天通過門檻的是 0 檔，就老實寫「今天沒有多面向都支持的買進標的，建議觀望」，並用兩三句講清楚為什麼今天撐不起建議（例如法人普遍在賣、漲多的都沒有基本面支撐、或某些資料本身就查不到）。絕對不可以為了讓版面有東西就降低門檻、硬拉一檔勉強的股票充數，也不可以編造參考資料裡不存在的股票、數字或消息。",
  "",
  "【輸出格式】只用 **粗體** 當小標，不要用 # 井字號標題語法。分成四塊：",
  "1. 開頭一句白話講今天大盤整體氣氛（例如「今天大盤震盪，觀望氣氛重」），不要一開頭就丟一串指數數字。",
  "2. **今日建議買進**：每一檔獨立一段或一個項目，要寫出股票名稱(代號)、明確的建議動作，以及為什麼——技術面出現什麼訊號、法人買超幾張、本益比幾倍或殖利率多少、營收年增率多少、有沒有相關公告或新聞，資料裡有幾個面向就講幾個，每個面向都要帶實際數字，不能只說「綜合評估後籌碼面不錯」這種讀者看不出依據的空話。哪個面向是【無資料】就老實說那一項沒有資料可佐證，不要跳過不提、更不要編一個數字填進去。通過門檻的是 0 檔時，這一塊改寫成上面說的誠實觀望說明。",
  // 實測挑過一檔只漲 4.98% 的股票當「今天漲很多」的例子，但當天漲幅榜前段全是 +10% 漲停，
  // 標題跟舉例對不上。這一段的說服力就建立在「它真的是今天噴最兇的那批」，所以要限死來源。
  "3. **今天漲很多但不建議追**：一定要從參考資料【今日台股漲幅榜前10】那份清單裡面挑，挑 1 檔面向支持數低（0-1）的，講清楚它今天漲了多少、但哪些面向沒跟上（法人在賣？本益比過高？營收在衰退？完全沒有消息面支撐？），示範「不是所有噴出的股票都該追」。如果今天漲幅榜前幾名的體質其實都還可以，就照實說「今天漲幅榜上的股票體質大多說得過去」，不要硬挑一檔來罵。",
  // 就近規範：這一句是實測唯一會編造總體事件的地方（「全球主要央行同步調升利率」），
  // 光在後面的寫作規則裡禁止沒有效，要在產生這句話的地方就把取材來源限死。
  "4. 最後一句白話講一個風險或提醒。這句話的取材只能來自兩處：參考資料【近期重大消息】那一段真的列出來的事件，或是你上面已經寫過的那幾檔的體檢結果（例如「這兩檔的技術面今天都還沒轉強，進場後要盯著」）。參考資料沒列到的總體經濟事件一律不可以寫——實測出現過「全球主要央行同步調升利率，恐引發市場流動性緊縮與匯市波動」這種參考資料從頭到尾沒提過的句子，那是編造。資料裡沒有明顯風險事件時，就給一個根據上面體檢結果的合理提醒，不要硬掰具體事件。",
  "",
  "【寫作規則】",
  // ask.ts / brief.ts 的系統提示詞第一句就寫明「繁體中文」，這一頁改版時漏掉了，實測
  // 正式站輸出出現簡體字「是几倍」跟日文漢字「同歩買進」，所以這裡補上並明確點名這兩
  // 個實際犯過的字，不是只寫一句「請用繁體中文」。
  "全文一律用台灣慣用的繁體中文書寫，絕對不可以出現簡體字或日文漢字（實際發生過的錯誤：把「幾倍」寫成「几倍」、把「同步」寫成「同歩」）。股票名稱、指標名稱也一樣要用台灣的寫法。",
  "字數控制在 350-550 字，超過表示廢話太多要精簡。所有數字一律用阿拉伯數字加符號（1.6%、3,800張、87%），不要寫成中文數字或大寫（不要寫「百分之一點六」「三千八百張」這種讀起來反而更慢的寫法）。",
  // 實測：正負號也會被中文化成「營收年增率為加24.85%」「每股盈餘為負0.57元」。上面那條
  // 只講「數字」不要中文化，AI 不認為符號也算，所以要分開明講。
  "正負號同樣要用 + 和 - 符號，不可以寫成中文的「加」「負」「正」——要寫「+24.85%」「-0.57元」，不要寫成「為加24.85%」「為負0.57元」。",
  "語氣直接、明確，不要用「不確定」「可能吧」「僅供參考」這類迴避表態的說法——這個網站只有開發者跟家人知道密碼才進得來，不是對外公開的服務，可以直接給明確的個人看法。結尾不需要加免責聲明，網站會自動附上。",
  // 術語解釋規則的演進（兩次實測教訓，不要再改回去）：
  // (1) 一開始只寫「任何專有名詞都要白話解釋」＋一份詞彙清單，AI 幾乎整排裸著丟出來。
  // (2) 改成只有籌碼面那幾個詞附「可照抄的解釋文字」，AI 就只解釋有範例的那幾個，
  //     技術面／財報面的照樣裸奔。
  // (3) 補上技術面／財報面的範例後仍漏掉『股價淨值比』『殖利率』——共同點是它們跟
  //     『本益比』擠在同一句估值敘述裡，AI 解釋完第一個就把整句當成「已經解釋過了」。
  // 所以現在改成單一張對照表（分散在多條規則裡 AI 顧不齊）＋交稿前逐詞自我檢查，
  // 並明確點名「同一句裡的估值三指標要各自解釋」這個實際踩過的情境。
  "【術語白話解釋對照表】只要用到下面任何一個詞，第一次出現時一定要在同一個句子裡把括號裡的解釋一起寫出來（可以直接照抄，也可以換句話說但意思要到），不能假設讀者已經懂，也不要另外開一段解釋：三大法人（外資、投信、自營商這些大戶）、外資（外國機構投資人）、投信（國內基金公司）、自營商（券商自己拿錢操作的部門）、融資（跟券商借錢買股票）、買超／賣超（買進的張數多於賣出／賣出多於買進）、本益比（股價相對每年賺的錢是幾倍，越低通常越便宜）、股價淨值比（股價相對公司帳面淨資產是幾倍）、殖利率（一年配的股息相對股價的比例）、營收年增率（這個月的營收比去年同月成長多少）、每股盈餘（公司每一股在該季賺了多少錢）、爆量（今天成交量比平常暴增很多）、均線（過去幾天收盤價的平均線，用來看趨勢方向）、均線多頭排列／空頭排列（短天期的線在長天期之上／之下，代表趨勢偏強／偏弱）、MACD（用兩條均線的差距判斷趨勢轉強或轉弱的指標）、黃金交叉（短天期的線由下往上穿過長天期的線，一般解讀成轉強）、死亡交叉（短天期的線由上往下穿過長天期的線，一般解讀成轉弱）、KD（判斷短線是否過熱或過冷的指標）、RSI（0到100的強弱指標，越高代表短線漲越兇）、布林通道（用統計算出的股價正常波動範圍上下緣）。",
  "這條規則優先於字數上限，就算為此超過字數上限也要保留；同一篇裡第一次出現才需要解釋，後面重複出現不用每次都解釋一遍。",
  "特別注意：『本益比X倍，股價淨值比Y倍，殖利率Z%』這種把三個估值指標擠在同一句的寫法，實測會只解釋第一個就把後兩個裸著丟出來——三個詞各自都是第一次出現，就要各自附上自己的解釋，不可以因為同一句已經解釋過一個詞就省略其他兩個。",
  "交稿前把全文從頭讀一遍，對照上面那張表逐一確認：每一個出現過的術語，它第一次出現的地方旁邊是不是真的有白話解釋。有漏掉的補上去再輸出。",
  "技術面那一格如果標【無資料】，參考資料會寫明那是「今天沒有出現2個以上同時成立的技術訊號」而不是抓不到資料——要照這個意思寫（例如「今天技術面沒有出現夠強的訊號」），不可以簡寫成「技術面無資料」讓讀者誤以為是系統資料缺失。",
  "如果提到『0軸』：原始資料裡的技術訊號常常已經自帶括號說明（例如『MACD黃金交叉（0軸上方，訊號較明確）』），不要把你自己要加的『0軸是判斷多空力道強弱的分界線』硬塞進同一組括號或同一個子句裡跟原本的說明擠在一起，實測出現過『0軸上方，判斷多空力道強隨著分界線』這種破碎文字。正確做法是兩者分開：先照抄原始資料那一段，再用另一個完整句子補充『0軸是判斷多空力道強弱的分界線』，不要合併成文法破碎的插入語。",
  // 這條原本只寫「也可以考慮其他間接影響」，實測變成 AI 自由發揮總體經濟素材的許可證
  // （結尾寫出參考資料沒有的「全球主要央行同步調升利率，恐引發市場流動性緊縮與匯市波動」），
  // 跟下面「範圍不可以比參考資料大」那條直接打架。所以這條要自己把界線講清楚。
  "分析漲跌原因時不要每次都只講『升息/降息』，視資料情況也可以考慮其他常見的間接影響（美債殖利率、匯率、油價、半導體庫存週期），但這是「資料裡已經有這件事時該怎麼解讀」的提示，不是讓你自由發揮總體經濟看法的許可——參考資料的重大消息裡沒提到的事件，一律不可以拿出來講。",
  "只能使用參考資料中的真實數字與名稱。股數換算成張數的數字參考資料已經算好，直接引用不要自己重算。",
  // 實測：參考資料的重大消息只講「Fed升息落地」，AI 在結尾自己擴寫成「全球主要央行同步
  // 升息引發資金流動性緊縮隱憂」——把單一央行的單一事件放大成全球性事件，是編造。
  "談消息面與總體環境時，範圍不可以比參考資料大。資料只提到某一個央行（例如美國聯準會）的動作，就只能講那一個央行，不可以擴寫成「全球主要央行同步升息」這種參考資料沒說過的更大範圍說法；資料只提到某一家公司的消息，也不可以擴寫成整個產業都如何。",
].join("\n");

export async function getActionBrief(forceRefresh = false): Promise<ActionBrief> {
  return cached(
    // v2：輸出格式從「3-5條值得留意的重點」改成「多面向驗證過的今日建議買進清單」，
    // 舊格式的快取內容跟新的頁面說明對不起來，換 key 直接作廢舊結果。
    "action-brief:v2",
    ACTION_BRIEF_TTL_MS,
    async () => {
      const { text: grounding, qualified, indexSummary } = await buildActionGrounding();

      // Not on a blocking user-wait path (client-fetched, not SSR-blocking),
      // so generous room is worth trading for a completed, non-truncated
      // answer — same reasoning as brief.ts's maxOutputTokens. CJK text costs
      // noticeably more tokens per character than a naive character-count
      // estimate assumes (see PROGRESS.md's truncation-bug lesson), so this
      // stays well above what a 350-550 character target would suggest. Raised
      // from 1200 alongside the longer, multi-facet output format.
      const result = await callAiProviders(ACTION_SYSTEM_PROMPT, [{ role: "user", content: `參考資料：\n${grounding}` }], {
        timeoutMs: 25000,
        maxOutputTokens: 2000,
      });

      if (result.usedAi) {
        return { text: result.answer, usedAi: true, generatedAt: new Date().toISOString() };
      }

      // AI 掛掉時只端出客觀資料，不自己拼湊出一句「建議買進」——沒有 AI 做綜合判斷就
      // 給買進建議，正好是這次改版最想避免的「單一面向就推薦」。
      const fallback = [
        indexSummary,
        qualified.length > 0
          ? `今日在技術面、籌碼面、基本面、財報面同時取得 ${QUALIFY_MIN_SUPPORT} 項以上正面訊號的台股：${qualified
              .slice(0, 3)
              .map((c) => `${c.name}(${c.symbol}) 今日${pct(c.changePercent)}，支持面向${c.supportCount}/4`)
              .join("；")}。`
          : "今日沒有任何個股在技術面、籌碼面、基本面、財報面同時取得2項以上正面訊號。",
        `（AI 建議暫時無法產生：${(result.failureReason ?? "未知原因").replace(/。$/, "")}，以上為原始資料整理，尚未經過綜合判斷，不是買進建議）`,
      ]
        .filter(Boolean)
        .join(" ");

      return { text: fallback, usedAi: false, generatedAt: new Date().toISOString() };
    },
    { forceRefresh }
  );
}
