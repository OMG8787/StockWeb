// 依使用者問的「主題」即時搜尋新聞（Google 新聞 RSS，免費、不需金鑰）。
//
// 2026-10-06 使用者回報：問「今天有沒有 美國 伊朗的新聞」，AI 回「資料裡沒有美國與伊朗相關的新聞」，
// 但 Google 新聞近 2 天有 100 則。根因：本站新聞只抓固定的「台股」「美股」市場新聞與個股新聞，
// 沒有依使用者問的主題搜尋，模型只能說沒有。這裡就是那個缺的搜尋。
//
// 設計重點：「搜尋成功但 0 則」與「搜尋這一刻失敗」必須分得出來（對使用者的說法完全不同），
// 所以用 fetchNewsStrict（失敗會丟例外），而且失敗結果不進快取。
import { cached } from "./cache";
import { dedupeNews, fetchNewsStrict, type NewsItem } from "./news";

/** 資料區塊標題前綴（askSystemCompose.ts 的 BLOCK_MARKERS.topicNews 共用；改這裡規則才不會悄悄消失）。 */
export const TOPIC_NEWS_TITLE = "【主題新聞搜尋";

export const TOPIC_NEWS_DAYS = 3;
export const TOPIC_NEWS_MAX_ITEMS = 8;
const TOPIC_NEWS_TTL_MS = 15 * 60_000;
/** 中文版結果少於這個數量時，再補查英文版（en-US）。 */
const MIN_ZH_RESULTS_BEFORE_EN = 4;

export type TopicNewsStatus = "ok" | "empty" | "failed";

export interface TopicNewsResult {
  topic: string;
  days: number;
  status: TopicNewsStatus;
  items: NewsItem[];
}

/** 快取鍵用：去前後空白、壓縮連續空白、英文轉小寫，同一個主題的不同打法共用一份快取。 */
export function normalizeTopicKey(topic: string): string {
  return topic.trim().replace(/\s+/g, " ").toLowerCase();
}

async function searchRaw(topic: string, days: number): Promise<TopicNewsResult> {
  const query = `${topic} when:${days}d`;
  const wantEn = /[A-Za-z]/.test(topic);
  let zh: NewsItem[] = [];
  let zhOk = true;
  try {
    zh = await fetchNewsStrict(query, 25, "zh-TW");
  } catch {
    zhOk = false;
  }
  let en: NewsItem[] = [];
  let enOk = true;
  let enTried = false;
  if (!zhOk || wantEn || zh.length < MIN_ZH_RESULTS_BEFORE_EN) {
    enTried = true;
    try {
      en = await fetchNewsStrict(query, 25, "en-US");
    } catch {
      enOk = false;
    }
  }
  if (!zhOk && (!enTried || !enOk)) throw new Error("topic news fetch failed");
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const items = dedupeNews([...zh, ...en].filter((n) => n.pubDate && Date.parse(n.pubDate) >= cutoff))
    .sort((a, b) => b.pubDate.localeCompare(a.pubDate))
    .slice(0, TOPIC_NEWS_MAX_ITEMS);
  return { topic, days, status: items.length > 0 ? "ok" : "empty", items };
}

/**
 * 搜尋主題新聞（近 days 天、去重、新到舊、最多 8 則；15 分鐘快取，鍵含正規化後的關鍵字）。
 * 抓取失敗回 status:"failed"（不進快取，下一題會重試），不丟例外。
 */
export async function searchTopicNews(topic: string, days = TOPIC_NEWS_DAYS): Promise<TopicNewsResult> {
  try {
    return await cached(`topicnews:v1:${normalizeTopicKey(topic)}:${days}`, TOPIC_NEWS_TTL_MS, () => searchRaw(topic, days));
  } catch {
    return { topic, days, status: "failed", items: [] };
  }
}

function taipeiMonthDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit" })
    .format(new Date(iso))
    .replace("/", "-");
}

/** 轉成給 AI 的資料區塊文字（純資料；怎麼用這些資料見 askSystemPrompt.ts 的 RULE_TOPIC_NEWS）。 */
export function formatTopicNewsBlock(r: TopicNewsResult): string {
  const head = `${TOPIC_NEWS_TITLE}：「${r.topic}」，近 ${r.days} 天】`;
  if (r.status === "failed") return `${head}\n搜尋狀態：這一刻新聞搜尋失敗（不是沒有新聞，是沒搜到）`;
  if (r.status === "empty") return `${head}\n搜尋狀態：搜尋成功，結果 0 則`;
  // 程式先編號（2026-10-06 評測：Lite 會把兩則不同新聞的標題混成一句）；AI 只能逐則引用、一行一則。
  const lines = r.items.map(
    (n, i) => `第${i + 1}則［${n.pubDate ? taipeiMonthDay(n.pubDate) : "日期不明"}］${n.title}${n.source ? `（${n.source}）` : ""}`
  );
  return `${head}\n搜尋狀態：搜尋成功，共 ${r.items.length} 則（Google 新聞標題，新到舊）\n${lines.join("\n")}`;
}
