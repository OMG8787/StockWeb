import { marginSignalLine } from "./marginSignal";
import {
  getChips,
  getChipsRanking,
  getChipsRatiosBatch,
  getEarnings,
  getFundamentals,
  getIndices,
  getMacroSnapshot,
  getMaterialAnnouncements,
  getMultiSignalStocks,
  getTaifexNightFutures,
  getValueScreen,
  searchStocks,
  type ChipsRankingItem,
  type MomentumItem,
  type ValueScreen,
} from "@/lib/data";
import type { ChipsRatios, Earnings, Fundamentals, MaterialAnnouncement } from "@/lib/data/types";
import type { Signal } from "@/lib/signals";
import { getNewsFeed, type NewsFeed } from "@/lib/ai/newsfeed";
import { formatSharesWithLots } from "@/lib/format";
import { buildMarketOverviewText } from "./marketOverview";
import { getStockRating, getStockRatings, type StockRatingResult } from "./stockRating";
import { describeSiteRating, isRecommendable, WEAK_MARKET_RET60_PCT, weakMarketNote } from "./siteRating";
import { getTaiexRet60Pct } from "./learning/regimeData";
import { PICK_GROUP_LIMIT, selectNotChase, selectPickGroups, type NotChasePick } from "./actionPicks";
import { stabilizeBuyPicks } from "./actionStability";
import {
  pct,
  score,
  type Candidate,
  type ScoredCandidate,
  PE_CHEAP,
  PE_EXPENSIVE,
  YIELD_GOOD,
  QUALIFY_MIN_SUPPORT,
  QUALIFY_MAX_AGAINST,
  SCORED_FACET_COUNT,
  SCORED_FACET_LABEL,
  MARGIN_UTIL_LOW,
  MARGIN_UTIL_HIGH,
  MARGIN_UTIL_SURGE_POINTS,
} from "./actionScoring";

// 2026-09-23 從 actionBrief.ts 拆出來的「候選名單組裝＋組成餵給AI的文字」邏輯——
// 見 actionScoring.ts 開頭的說明，那份只管單一候選股怎麼打分數，這份負責「去哪裡
// 湊出候選名單」跟「怎麼把整批資料排版成AI看得懂的參考資料文字」，兩者職責不同。

const MOMENTUM_LIMIT = 8;
// 漲幅榜刻意也被納入「完整體檢」的候選名單，不是只拿來當背景資料：使用者明確要求
// 「不是漲停的就推薦要買」，要示範這個判斷邏輯，AI 手上就必須有「今天漲最多的那幾檔
// 在其他面向到底有沒有跟上」的完整資料，才有辦法具體講出「這檔漲 9% 但法人在賣、
// 本益比 60 倍，不建議追」這種反例。只給它一份沒有體檢資料的漲幅榜，它只能含糊帶過。
const GAINER_CANDIDATE_LIMIT = 6;
const CHIP_CANDIDATE_LIMIT = 6;
const TRUST_CANDIDATE_LIMIT = 4;
// 2026-09-21 使用者反映今日建議/AI問答推薦的幾乎全是當天漲停/大漲的標的，感覺
// 只看動能、不是真的整合各方資訊——查證後確認候選名單原本只有「技術訊號共振
// （本身也偏動能，見 momentum.ts 同日修正）／今日漲幅榜／法人籌碼」三種來源，
// 全部都跟「今天的價格表現」掛勾，本益比/殖利率/股價淨值比這些「基本面便宜但
// 今天沒有大漲」的股票，就算資料裡有算（見 getValueScreen），也從來沒有機會被
// 納入候選名單、更不可能出現在「已篩過的結果」裡——不是 AI 選擇忽略，是候選池
// 從一開始就沒放進去。新增這三份估值排行當作候選來源，跟其他來源一樣要通過
// 下面的「面向支持數」門檻才會被列進合格名單，不是「便宜就直接推薦」。
const VALUE_CANDIDATE_LIMIT = 4;
// 體檢表的總長度上限。每一檔的各個面向全部來自「整個市場一次抓回來再查表」的既有快取
// （fundamentals:TW:all、chips:TW:institutional、earnings:TW:revenue、
// announcements:TW:all，以及持股結構面的融資／外資持股／集保週快照），所以多一檔幾乎不花額外的網路成本，真正的限制是 prompt 長度
// 跟 AI 一次能認真讀完的資訊量。從16調高到22，讓新增的估值類候選來源有實際空間，
// 不會被動能類來源早早佔滿名額（見 buildCandidates 裡的加入順序）。
const CANDIDATE_LIMIT = 22;
// 流動性下限，跟 getValueScreen 的 VALUE_SCREEN_MIN_TURNOVER_TWD 同一個理由：漲幅榜
// 前幾名常常被「一天只成交幾萬元的殭屍股」佔滿，那種股票就算列出來也買不到、賣不掉，
// 拿來當建議或反例都沒有意義。
const CANDIDATE_MIN_TURNOVER_TWD = 30_000_000;
// 美股只補最前面幾檔的基本面/財報：美股沒有全市場批次端點，每一檔都是獨立一次 Yahoo
// 請求，補太多會把整頁的延遲拖進 AI 呼叫的時間預算裡。美股也沒有公開的法人籌碼資料源，
// 本來就湊不齊四個面向，所以這一頁的買進建議本質上以台股為主。
const US_ENRICH_LIMIT = 4;

function describeCandidate(c: ScoredCandidate): string {
  const head = `● ${c.name}(${c.symbol})　現價 ${c.price}　今日 ${pct(c.changePercent)}　入選原因：${c.sources.join("／")}`;
  const body = [...c.facets, c.newsFacet].map((f) => `　- ${f.name}【${f.verdict}】${f.detail}`);
  // 融資融券組合判讀（程式算好、只有非中性才附，見 marginSignal.ts）；不計分，只是給 AI 解說籌碼的線索。
  const margin = marginSignalLine(c.chips, c.changePercent);
  const marginRow = margin ? [`　- ${margin}`] : [];
  const tail = `　→ 面向支持數：${c.supportCount}/${SCORED_FACET_COUNT}（其中明確不支持 ${c.againstCount} 項）`;
  return [head, ...body, ...marginRow, tail].join("\n");
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
  newsFeed: NewsFeed,
  valueScreen: ValueScreen
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
      chipsRatios: null,
      fundamentals: null,
      earnings: null,
      announcements: [],
      headlines: [],
    });
  };

  twMomentum.slice(0, MOMENTUM_LIMIT).forEach((m) => add(m, "技術訊號共振清單", m.signals));
  // 估值類來源刻意排在漲幅榜/籌碼之前加入：base.size 到達 CANDIDATE_LIMIT 後，
  // 後面才呼叫的 add() 對新股票會被靜默捨棄（見上面 add() 的實作），所以先加入
  // 才能確保這些「今天沒有大漲、但基本面便宜」的股票真的有機會佔到候選名額，
  // 不會每次都被動能類來源先佔滿。
  valueScreen.lowPe.slice(0, VALUE_CANDIDATE_LIMIT).forEach((s, i) => add(s, `低本益比排行第${i + 1}名`));
  valueScreen.highYield.slice(0, VALUE_CANDIDATE_LIMIT).forEach((s, i) => add(s, `高殖利率排行第${i + 1}名`));
  valueScreen.lowPb.slice(0, VALUE_CANDIDATE_LIMIT).forEach((s, i) => add(s, `低股價淨值比排行第${i + 1}名`));
  gainers.slice(0, GAINER_CANDIDATE_LIMIT).forEach((g, i) => add(g, `今日漲幅榜第${i + 1}名`));
  chipsRanking.foreignBuy.slice(0, CHIP_CANDIDATE_LIMIT).forEach((s, i) => add(s, `外資買超榜第${i + 1}名`));
  chipsRanking.institutionalBuy.slice(0, CHIP_CANDIDATE_LIMIT).forEach((s, i) => add(s, `三大法人買超榜第${i + 1}名`));
  chipsRanking.trustBuy.slice(0, TRUST_CANDIDATE_LIMIT).forEach((s, i) => add(s, `投信買超榜第${i + 1}名`));

  // 真實新聞標題（排除 kind === "data"：那些是本站自己算出來的技術訊號卡片，不是外部
  // 新聞，拿來當「消息面佐證」等於把技術面重複計算兩次）。
  const realHeadlines = [...newsFeed.pinned, ...newsFeed.items].filter((n) => n.kind === "news").map((n) => n.title);

  const candidates = [...base.values()];
  // 持股結構面（大戶／外資／融資）：全市場整包快取、純記憶體查表，整批一次查，不用每檔各打一次。
  // 不開 majorPrevFromWeb：候選股遠超過 MAJOR_WEB_FALLBACK_MAX_SYMBOLS，開了也不會生效，
  // 本站週快照沒有上一週的那幾檔就照實標「無法比較」。
  const ratiosPromise = getChipsRatiosBatch(candidates.map((c) => c.symbol)).catch(
    () => new Map<string, ChipsRatios | null>()
  );
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
  const ratios = await ratiosPromise;
  for (const c of candidates) c.chipsRatios = ratios.get(c.symbol) ?? null;

  return candidates
    .map(score)
    .sort(
      (a, b) =>
        b.supportCount - a.supportCount ||
        a.againstCount - b.againstCount ||
        b.changePercent - a.changePercent ||
        // 2026-10-06：全部同分時以代號定序（原本靠加入順序，來源清單順序一變就換名單），相同輸入必得相同名單。
        a.symbol.localeCompare(b.symbol)
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

/** 今日建議名單最多對幾檔算本站綜合評等（每檔可能要抓日K，見 stockRating.ts）。 */
const RATED_PICK_LIMIT = 8;
/** 「不建議追」挑中的股票若本站評等其實是建議買進，最多換幾次（每次可能多算一檔評等）。 */
const NOT_CHASE_VERIFY_ATTEMPTS = 3;

export interface RatedPick {
  /** 上一份名單保留下來、這次候選池沒有的股票沒有候選資料（null） */
  candidate: ScoredCandidate | null;
  rating: StockRatingResult;
}

export interface ActionGroundingOptions {
  /**
   * 同一個「資料已定」時段（見 actionStability.ts）上一份名單的評等：這次重算時，其中的股票只有被重新評等為
   * 「不建議買進」才會被換掉，上游抓失敗（沒有評等）則保留。沒給＝完全依這次的候選排序（盤中、測試、評測）。
   */
  previousPicks?: readonly StockRatingResult[];
}

export interface ActionGrounding {
  text: string;
  /** 通過「面向支持數 ≥2 且明確不支持 ≤1」門檻的候選股。 */
  qualified: ScoredCandidate[];
  /** qualified 再經本站綜合評等（stockRating.ts）後，評等為「建議買進／建議等回檔再買」的——今日建議只能列這些。 */
  picks: RatedPick[];
  indexSummary: string;
  /** 「不建議追」程式選定的一檔（已排除建議名單；沒有合適的是 null） */
  notChase: NotChasePick | null;
  gainersAvailable: boolean;
  /** 大盤偏弱提示（加權 60 日報酬 < WEAK_MARKET_RET60_PCT；不弱或抓不到是 null） */
  marketNote: string | null;
  /**
   * 這次算名單時哪些上游整份抓不到（報價表、技術訊號共振清單、法人買超榜、估值排行為空，或候選股的評等沒算出來）。
   * 空陣列＝輸入完整。非空時名單只快取很短（見 actionBrief.ts），且不當作「上一份名單」存檔。
   */
  degradedReasons: string[];
}

/**
 * 抽成獨立的 exported 函式（而不是留在 getActionBrief 裡）是為了能單獨檢查餵給 AI 的
 * 原始資料。這一頁的正確性幾乎完全取決於 grounding 有沒有如實呈現各面向——「建議買進」
 * 這種話一旦建立在錯的或半套的資料上，比寫得含糊還糟——所以讓它可以被單獨叫起來檢查。
 */
export async function buildActionGrounding(opts: ActionGroundingOptions = {}): Promise<ActionGrounding> {
  const [indices, taifexFutures, macro, twMomentum, usMomentum, newsFeed, chipsRanking, valueScreen, twAll] =
    await Promise.all([
      getIndices(),
      getTaifexNightFutures().catch(() => null),
      getMacroSnapshot(),
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
  // 上面每個來源失敗都被 .catch 吞成空清單：不記下來的話，缺了一整個來源的名單會被當成正常結果快取 10 分鐘。
  const degradedReasons: string[] = [];
  if (twAll.length === 0) degradedReasons.push("全市場報價表為空");
  if (twMomentum.length === 0) degradedReasons.push("技術訊號共振清單為空");
  if (chipsRanking.institutionalBuy.length === 0 && chipsRanking.foreignBuy.length === 0) degradedReasons.push("法人買超榜為空");
  if (valueScreen.lowPe.length === 0 && valueScreen.highYield.length === 0 && valueScreen.lowPb.length === 0) degradedReasons.push("估值排行為空");

  const usTargets = usMomentum.slice(0, US_ENRICH_LIMIT);
  const usExtras = new Map<string, { fundamentals: Fundamentals | null; earnings: Earnings | null }>();
  const [candidates] = await Promise.all([
    buildCandidates(twMomentum, liquidGainers, chipsRanking, newsFeed, valueScreen),
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

  // 2026-10-05：今日建議、AI 問答、個股問答三個入口的結論要一致——名單只列本站綜合評等為
  // 「建議買進／建議等回檔再買」的（跟個股頁問AI讀同一份 10 分鐘快取），評等字樣照用。
  const rated = qualified.slice(0, RATED_PICK_LIMIT);
  const previous = opts.previousPicks ?? [];
  const ratedKeys = new Set(rated.map((c) => c.symbol.toUpperCase()));
  // 上一份名單的股票也要重新評等（10 分鐘快取，多半命中）：才分得出「明確變成不建議買進」與「這次抓不到」。
  const previousExtra = previous.filter((p) => !ratedKeys.has(p.symbol.toUpperCase()));
  const ratings = await getStockRatings(
    [...rated.map((c) => ({ symbol: c.symbol, market: "TW" as const })), ...previousExtra.map((p) => ({ symbol: p.symbol, market: "TW" as const }))],
    undefined,
    "today-brief"
  ).catch(() => new Map<string, StockRatingResult>());
  if (rated.some((c) => !ratings.has(c.symbol.toUpperCase()))) degradedReasons.push("部分候選股的本站評等沒算出來");
  const candidateBySymbol = new Map(candidates.map((c) => [c.symbol.toUpperCase(), c] as const));
  const toItem = (r: StockRatingResult) => ({
    symbol: r.symbol,
    name: r.name,
    rating: r.rating,
    pick: { candidate: candidateBySymbol.get(r.symbol.toUpperCase()) ?? null, rating: r } as RatedPick,
  });
  const allPicks = rated
    .map((c) => ({ candidate: c, rating: ratings.get(c.symbol.toUpperCase()) }))
    .filter((p): p is { candidate: ScoredCandidate; rating: StockRatingResult } => !!p.rating && isRecommendable(p.rating.rating))
    .map((p) => toItem(p.rating));
  // 2026-10-05：分組、每組上限、排序、去重由程式決定（actionPicks.ts），AI 只寫解說——AI 曾在等回檔列 7 檔。
  // 2026-10-06：資料已定的時段，上一份名單的成員只有被重新評等為不建議買進才換掉（actionStability.ts）。
  const ranked = selectPickGroups(allPicks, Number.MAX_SAFE_INTEGER).buy;
  const members =
    previous.length > 0
      ? stabilizeBuyPicks({
          previous: previous.map(toItem),
          ranked,
          fresh: new Map(
            [...ratings.values()].filter((r) => isRecommendable(r.rating)).map((r) => [r.symbol.toUpperCase(), toItem(r)] as const)
          ),
          rejected: new Set([...ratings.values()].filter((r) => !isRecommendable(r.rating)).map((r) => r.symbol.toUpperCase())),
          limit: PICK_GROUP_LIMIT,
        })
      : ranked;
  const groups = selectPickGroups(members, PICK_GROUP_LIMIT);
  const picks: RatedPick[] = groups.buy.map((g) => g.pick);
  const ret60 = await getTaiexRet60Pct().catch(() => null);
  const marketNote = ret60 != null && ret60 < WEAK_MARKET_RET60_PCT ? weakMarketNote(ret60) : null;
  // 體檢表裡已有本站評等的候選股，五面向與支持數一律改用評等那份（2026-10-06 整合稽核：候選股原本用技術訊號共振清單／
  // 漲幅榜的訊號另算一次，同一檔在體檢表寫「支持 1/5」、評等行卻寫「支持面向 3/5」，AI 與使用者看到兩個數字）。
  const shown = candidates.map((c) => {
    const r = ratings.get(c.symbol.toUpperCase());
    return r ? { ...c, facets: r.facets, supportCount: r.rating.supportCount, againstCount: r.rating.againstCount } : c;
  });
  // 「不建議追」也由程式挑，並且一定排除建議名單裡的代號（互斥）；挑中的那一檔再查一次本站評等（快取命中為主），
  // 評等其實是建議買進就換下一檔——否則今日建議寫「不建議追 X」、個股頁問 AI 卻說「建議買進 X」。
  const notChaseExclude = new Set([
    ...picks.map((p) => p.rating.symbol.toUpperCase()),
    ...[...ratings.values()].filter((r) => isRecommendable(r.rating)).map((r) => r.symbol.toUpperCase()),
  ]);
  let notChase: NotChasePick | null = null;
  for (let attempt = 0; attempt < NOT_CHASE_VERIFY_ATTEMPTS; attempt++) {
    const cand = selectNotChase(liquidGainers, shown, notChaseExclude);
    if (!cand) break;
    const r = ratings.get(cand.symbol.toUpperCase()) ?? (await getStockRating(cand.symbol, "TW", "today-brief").catch(() => null));
    if (r && isRecommendable(r.rating)) {
      notChaseExclude.add(cand.symbol.toUpperCase());
      continue;
    }
    notChase = r
      ? {
          ...cand,
          supportCount: r.rating.supportCount,
          weakFacets: r.facets.filter((f) => f.verdict !== "支持").map((f) => f.name.replace(/（.*$/, "")),
        }
      : cand;
    break;
  }
  const notRecommended = rated
    .map((c) => ratings.get(c.symbol.toUpperCase()))
    .filter((r): r is StockRatingResult => !!r && !isRecommendable(r.rating));

  const indexSummary =
    indices.length > 0
      ? `大盤：${indices.map((i) => `${i.name} ${i.change >= 0 ? "+" : ""}${i.changePercent}%`).join("、")}。`
      : "大盤指數目前無法取得。";

  const text = [
    "【大盤概況（台股＋美股）】",
    buildMarketOverviewText(indices, taifexFutures, macro),
    "",
    "【今日台股候選股「多面向體檢表」——這是你做買進判斷的主要依據】",
    "候選來源刻意混合四種挑法：技術訊號共振清單、今日漲幅榜、三大法人買超榜、投信買超榜，所以這份名單裡同時有「多面向都到位的標的」跟「只有單一面向亮眼、其他面向沒跟上的假訊號」，請自己分辨，不要因為某檔出現在名單上就當成推薦。",
    `「面向支持數」是本站用客觀規則算好的（${SCORED_FACET_LABEL}共 ${SCORED_FACET_COUNT} 項，各自標【支持】【中性】【不支持】【無資料】），直接引用即可，不要自己重算或改成別的數字。「籌碼面」是三大法人當天的買賣超（流量）；「持股結構面」是大戶持股比例（集保週資料，跟上一週比）、外資持股比例（跟前一交易日比）、融資使用率這三項持股比例（存量）的變化，兩者是不同的面向。持股結構面的規則（本站自訂、非權威標準）：大戶持股較上一週上升、外資持股較前一交易日上升、融資使用率低於 ${MARGIN_UTIL_LOW}% 或下降各算加分；大戶週減、外資持股下降、融資使用率 ${MARGIN_UTIL_HIGH}% 以上或單日上升 ${MARGIN_UTIL_SURGE_POINTS} 個百分點以上（散戶槓桿過熱）各算扣分；加分≥2且無扣分為【支持】、扣分≥2為【不支持】，每一項後面標的（加分）（扣分）就是這樣算出來的。消息面刻意不判斷利多利空、也不計入支持數，只把真實標題端給你，方向要你自己讀標題判斷。本站設定的估值分界：本益比 ${PE_CHEAP} 倍以下算便宜、${PE_EXPENSIVE} 倍以上算貴、殖利率 ${YIELD_GOOD}% 以上算高。`,
    shown.length > 0 ? shown.map(describeCandidate).join("\n") : "（今日無候選股資料）",
    "",
    `【本站已先幫你篩過的結果】今日候選股中，面向支持數 ≥${QUALIFY_MIN_SUPPORT} 且明確不支持面向 ≤${QUALIFY_MAX_AGAINST} 的共 ${qualified.length} 檔：${
      qualified.length > 0 ? qualified.map((c) => `${c.name}(${c.symbol})`).join("、") : "無"
    }`,
    // 2026-10-05 使用者：「明日操作建議都沒有建議買的，是太保守嗎？」——評等改果斷二分，只剩建議買進一組（最多 PICK_GROUP_LIMIT 檔）。
    `【建議買進名單（程式已決定，共 ${picks.length} 檔，最多 ${PICK_GROUP_LIMIT} 檔；不可增減，跟個股頁「問AI關於」同一份評等；每一檔都是現價可分批買）】`,
    picks.length > 0 ? picks.map((p) => describeSiteRating(p.rating.name, p.rating.symbol, p.rating.rating)).join("\n") : "（無）",
    marketNote ? `【${marketNote}】` : "",
    notRecommended.length > 0
      ? `【體質過門檻、但本站綜合評等為「建議先不要買」的（不可列進建議）】\n${notRecommended.map((r) => describeSiteRating(r.name, r.symbol, r.rating)).join("\n")}`
      : "",
    notChase
      ? `【先不要買／不建議追（程式已選定，只寫這一檔）】${notChase.name}(${notChase.symbol})：今日${pct(notChase.changePercent)}，面向支持數 ${notChase.supportCount}，沒跟上的面向：${notChase.weakFacets.join("、") || "無"}`
      : `【先不要買／不建議追（程式已選定）】${liquidGainers.length > 0 ? "漲幅榜前段體質大多說得過去，沒有要點名的" : "今日漲幅榜無資料"}`,
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

  return { text, qualified, picks, indexSummary, notChase, gainersAvailable: liquidGainers.length > 0, marketNote, degradedReasons };
}
