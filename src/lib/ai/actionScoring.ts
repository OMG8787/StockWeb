import type { Chips, Earnings, Fundamentals, MaterialAnnouncement } from "@/lib/data/types";
import type { Signal } from "@/lib/signals";
import { formatSharesWithLots } from "@/lib/format";

// pct() 刻意放在這個「最底層」的檔案（不依賴 actionGrounding.ts），雖然它主要是給
// 文字組裝用的格式化函式——但 technicalFacet/earningsFacet 這兩個評分函式也要用到
// 它，如果放進 actionGrounding.ts 會變成 actionScoring.ts 反過來依賴
// actionGrounding.ts，跟 actionGrounding.ts 依賴 actionScoring.ts 的方向衝突、
// 兜成循環依賴。actionGrounding.ts／actionBrief.ts 需要它就直接從這裡 import。
export function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}%`;
}

// 2026-09-23 從 actionBrief.ts 拆出來的「打分數」邏輯——原本跟候選名單組裝、
// 文字組裝、AI提示詞全部擠在一個570行的檔案裡，改今日建議的評分規則要先讀懂
// 整個檔案才敢下手。這裡只負責「一檔候選股在技術面/籌碼面/基本面/財報面/
// 消息面各自的表現該打【支持】【中性】【不支持】【無資料】哪個評級」，不碰
// 候選名單怎麼湊齊、也不碰要組成什麼文字餵給AI——那兩塊留在 actionGrounding.ts。

// 進入「建議買進」候選的客觀門檻。prompt 裡也會重述一次，但真正決定 qualified 名單、
// 以及 AI 掛掉時 fallback 怎麼寫的是這兩個常數——不讓 AI 自己心證判斷夠不夠格。
export const QUALIFY_MIN_SUPPORT = 2;
export const QUALIFY_MAX_AGAINST = 1;

// 估值的粗略分界線。這是本站自己設的門檻、不是什麼權威標準，所以 prompt 裡也要求 AI
// 引用實際數字（「本益比 12 倍」）而不是只轉述「便宜」這個結論。
export const PE_CHEAP = 20;
export const PE_EXPENSIVE = 40;
export const YIELD_GOOD = 4;

// tone 是 "up" 但實際上是「漲多了」的警訊，不是買進理由——PROGRESS.md 記過一個真實
// 教訓：同一筆「RSI 86 超買」資料，今日建議頁講成警訊、聊天追問裡卻拿來當正面理由。
// 這裡直接在資料層把它們跟真正的多方訊號分開，AI 就不會把「超買」算進支持面向裡。
const OVERHEAT_PATTERNS = ["超買", "布林通道上緣"];

export type Verdict = "支持" | "中性" | "不支持" | "無資料";

export interface Facet {
  name: string;
  verdict: Verdict;
  detail: string;
}

export interface Candidate {
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

export interface ScoredCandidate extends Candidate {
  facets: Facet[];
  supportCount: number;
  againstCount: number;
  newsFacet: Facet;
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
  const lines = c.announcements.slice(0, 2).map((a) => `${a.date}：${a.subject.length > 60 ? `${a.subject.slice(0, 60)}…` : a.subject}`);
  const headlines = c.headlines.slice(0, 2);
  if (lines.length === 0 && headlines.length === 0) {
    return { name: "消息面", verdict: "無資料", detail: "查無相關重大訊息或新聞標題" };
  }
  const detail = [
    lines.length > 0 ? `重大訊息：${lines.join("；")}` : "",
    headlines.length > 0 ? `相關新聞標題：${headlines.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("｜");
  return { name: "消息面", verdict: "中性", detail };
}

export function score(c: Candidate): ScoredCandidate {
  const facets = [technicalFacet(c), chipsFacet(c), valuationFacet(c), earningsFacet(c)];
  return {
    ...c,
    facets,
    supportCount: facets.filter((f) => f.verdict === "支持").length,
    againstCount: facets.filter((f) => f.verdict === "不支持").length,
    newsFacet: newsFacet(c),
  };
}
